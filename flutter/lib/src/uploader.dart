import 'dart:async';
import 'dart:math';

import 'logger.dart';
import 'queue.dart';
import 'transport.dart';

/// Sends the queue in batches and applies the protocol's response rules
/// (§1) and retry rules (§5).
///
/// At most one request is in flight: a flush while one is running joins it,
/// and the running flush keeps going until the queue is empty.
class Uploader {
  /// Creates an uploader.
  Uploader({
    required EventQueue queue,
    required Transport transport,
    required RabolicLogger logger,
    required Random random,
    required bool Function() canSend,
  }) : _queue = queue,
       _transport = transport,
       _logger = logger,
       _random = random,
       _canSend = canSend;

  /// The longest backoff.
  static const Duration maxBackoff = Duration(seconds: 300);

  final EventQueue _queue;
  final Transport _transport;
  final RabolicLogger _logger;
  final Random _random;
  final bool Function() _canSend;

  Future<void>? _running;
  Timer? _retryTimer;
  int _failures = 0;
  bool _unauthorized = false;

  /// Whether a request is in flight.
  bool get isSending => _running != null;

  /// Whether a retry is scheduled after a failure or a 429.
  bool get isWaitingToRetry => _retryTimer?.isActive ?? false;

  /// Whether a 401 stopped sending for the rest of the process.
  bool get isUnauthorized => _unauthorized;

  /// Stops sending for the rest of the process after a 401, keeping the
  /// queue for the next launch.
  void markUnauthorized() {
    _unauthorized = true;
    _retryTimer?.cancel();
    _logger.errorOnce(
      'unauthorized',
      'the project key was rejected (401). Sending is stopped until the app '
          'restarts; queued events are kept. Check RabolicConfig.projectKey.',
    );
  }

  /// Sends everything queued. Does nothing while a retry is pending; the
  /// retry will send.
  Future<void> flush() {
    final running = _running;
    if (running != null) return running;
    if (isWaitingToRetry || _unauthorized) return Future<void>.value();
    // _running is set before _drain starts because _drain can finish
    // synchronously (empty queue), and its `finally` must win.
    final done = Completer<void>();
    _running = done.future;
    unawaited(_drain().whenComplete(done.complete));
    return done.future;
  }

  /// Cancels a pending retry.
  void dispose() => _retryTimer?.cancel();

  Future<void> _drain() async {
    try {
      while (!_unauthorized && _canSend()) {
        _queue.dropExpired();
        final batch = _queue.nextBatch();
        if (batch.isEmpty) return;
        if (!await _send(batch)) return;
      }
    } on Object catch (error) {
      _logger.debug('flush failed: $error');
    } finally {
      _running = null;
    }
  }

  /// Sends [batch]; returns whether sending may continue.
  Future<bool> _send(List<QueuedEvent> batch) async {
    _logger.debug('sending ${batch.length} events');
    final response = await _transport.sendBatch(batch);
    switch (response.outcome) {
      case BatchOutcome.accepted:
        _queue.remove(batch);
        _failures = 0;
        _logAccepted(response);
        return true;
      case BatchOutcome.invalid:
        _queue.remove(batch);
        _logger.error(
          'dropped a batch of ${batch.length} events the server '
          'called malformed (400): ${response.body?['message'] ?? ''}',
        );
        return true;
      case BatchOutcome.rejected:
        _queue.remove(batch);
        _logger.error(
          'dropped a batch of ${batch.length} events after a '
          '${response.statusCode} response',
        );
        return true;
      case BatchOutcome.tooLarge:
        if (batch.length == 1) {
          _queue.remove(batch);
          _logger.error('dropped event ${batch.single.id}: too large to send');
          return true;
        }
        final half = batch.length ~/ 2;
        return await _send(batch.sublist(0, half)) &&
            await _send(batch.sublist(half));
      case BatchOutcome.unauthorized:
        markUnauthorized();
        return false;
      case BatchOutcome.rateLimited:
        _scheduleRetry(response.retryAfter ?? _nextBackoff());
        return false;
      case BatchOutcome.retry:
        _scheduleRetry(_nextBackoff());
        return false;
    }
  }

  /// `min(300 s, 1 s × 2^attempt) × random(0.5–1.0)`, where `attempt`
  /// counts the failures since the last 200, starting at 0.
  Duration _nextBackoff() {
    final base = min(
      maxBackoff.inMilliseconds,
      1000 * pow(2, min(_failures, 9)),
    );
    _failures++;
    final jitter = 0.5 + _random.nextDouble() * 0.5;
    return Duration(milliseconds: (base * jitter).round());
  }

  void _scheduleRetry(Duration delay) {
    _logger.debug('retrying in ${delay.inMilliseconds} ms');
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      unawaited(flush());
    });
  }

  void _logAccepted(BatchResponse response) {
    final body = response.body;
    if (body == null) return;
    final rejected = body['rejected'];
    if (rejected is List<Object?> && rejected.isNotEmpty) {
      for (final item in rejected) {
        if (item is Map<String, Object?>) {
          _logger.debug('event ${item['index']} rejected: ${item['reason']}');
        }
      }
    }
    final dropped = body['dropped'];
    if (dropped is num && dropped > 0) {
      _logger.debug('$dropped events dropped: over the monthly cap');
    }
  }
}
