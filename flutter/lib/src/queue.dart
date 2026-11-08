import 'dart:async';
import 'dart:convert';

import 'clock.dart';
import 'logger.dart';
import 'storage/queue_store.dart';

/// One event waiting to be sent, kept in its serialized form so retries send
/// exactly the same bytes (and the same `event_id`).
class QueuedEvent {
  /// Creates a queued event.
  QueuedEvent({required this.id, required this.timestamp, required this.json});

  /// Parses a stored line, or returns `null` when it is damaged.
  static QueuedEvent? tryParse(String line) {
    if (line.trim().isEmpty) return null;
    try {
      final decoded = jsonDecode(line);
      if (decoded is! Map<String, Object?>) return null;
      final id = decoded['event_id'];
      final timestamp = decoded['timestamp'];
      if (id is! String || timestamp is! String) return null;
      return QueuedEvent(
        id: id,
        timestamp: DateTime.parse(timestamp),
        json: line,
      );
    } on FormatException {
      return null;
    }
  }

  /// The `event_id`.
  final String id;

  /// When the event happened.
  final DateTime timestamp;

  /// The serialized event.
  final String json;

  /// The serialized size in bytes.
  late final int bytes = utf8.encode(json).length;
}

/// The ordered, size-capped, persisted event queue (protocol §5).
class EventQueue {
  /// Creates an empty queue. Call [load] to restore the persisted one.
  EventQueue({
    required QueueStore store,
    required this.maxSize,
    required Clock clock,
    required RabolicLogger logger,
  }) : _store = store,
       _clock = clock,
       _logger = logger;

  /// Events older than this are dropped before sending.
  static const Duration maxAge = Duration(days: 7);

  /// Most events in one batch.
  static const int maxBatchEvents = 500;

  /// Most serialized bytes in one batch.
  static const int maxBatchBytes = 900 * 1024;

  final QueueStore _store;
  final Clock _clock;
  final RabolicLogger _logger;

  /// The most events kept. The oldest is dropped when it is exceeded.
  final int maxSize;

  final List<QueuedEvent> _events = <QueuedEvent>[];
  bool _dirty = false;
  Future<void>? _saving;

  /// How many events are queued.
  int get length => _events.length;

  /// Whether the queue is empty.
  bool get isEmpty => _events.isEmpty;

  /// The queued events, oldest first.
  List<QueuedEvent> get events => List<QueuedEvent>.unmodifiable(_events);

  /// Restores the persisted queue, skipping damaged lines and expired
  /// events, and keeping the newest [maxSize].
  Future<void> load() async {
    final lines = await _store.load();
    final restored = <QueuedEvent>[];
    for (final line in lines) {
      final event = QueuedEvent.tryParse(line);
      if (event != null) restored.add(event);
    }
    final damaged =
        lines.where((l) => l.trim().isNotEmpty).length - restored.length;
    if (damaged > 0) _logger.debug('skipped $damaged damaged queued events');
    _events.insertAll(0, restored);
    final trimmed = _trimToMaxSize();
    final expired = dropExpired();
    if (damaged > 0 || trimmed > 0 || expired > 0) _scheduleSave();
  }

  /// Appends [event], dropping the oldest events when the queue is full.
  void add(QueuedEvent event) {
    _events.add(event);
    _trimToMaxSize();
    _scheduleSave();
  }

  /// Appends [events] in order.
  void addAll(Iterable<QueuedEvent> events) {
    _events.addAll(events);
    _trimToMaxSize();
    _scheduleSave();
  }

  /// Drops events older than [maxAge] and returns how many were dropped.
  int dropExpired() {
    final cutoff = _clock().subtract(maxAge);
    final before = _events.length;
    _events.removeWhere((e) => e.timestamp.isBefore(cutoff));
    final dropped = before - _events.length;
    if (dropped > 0) {
      _logger.debug('dropped $dropped events older than 7 days');
      _scheduleSave();
    }
    return dropped;
  }

  /// The oldest events that fit in one batch: at most [maxBatchEvents] and
  /// [maxBatchBytes], but always at least one event when any are queued.
  List<QueuedEvent> nextBatch() {
    final batch = <QueuedEvent>[];
    var bytes = 0;
    for (final event in _events) {
      if (batch.length == maxBatchEvents) break;
      // +1 for the comma between events.
      if (batch.isNotEmpty && bytes + event.bytes + 1 > maxBatchBytes) break;
      batch.add(event);
      bytes += event.bytes + 1;
    }
    return batch;
  }

  /// Removes [sent] from the queue. Events already gone (dropped as
  /// oldest, or cleared) are ignored.
  void remove(Iterable<QueuedEvent> sent) {
    final ids = sent.map((e) => e.id).toSet();
    final before = _events.length;
    _events.removeWhere((e) => ids.contains(e.id));
    if (_events.length != before) _scheduleSave();
  }

  /// Removes every event, in memory and on disk.
  void clear() {
    if (_events.isEmpty) return;
    _events.clear();
    _scheduleSave();
  }

  /// Completes when the queue on disk matches the queue in memory.
  Future<void> persisted() async {
    while (_saving != null) {
      await _saving;
    }
  }

  int _trimToMaxSize() {
    final excess = _events.length - maxSize;
    if (excess <= 0) return 0;
    _events.removeRange(0, excess);
    _logger.debug('queue full: dropped the $excess oldest events');
    return excess;
  }

  // Saves are coalesced: many changes in one turn of the event loop cause
  // one write, and a change during a write causes exactly one more.
  void _scheduleSave() {
    _dirty = true;
    _saving ??= _saveLoop();
  }

  Future<void> _saveLoop() async {
    try {
      await Future<void>.value();
      while (_dirty) {
        _dirty = false;
        final lines = _events.map((e) => e.json).toList(growable: false);
        try {
          await _store.save(lines);
        } on Object catch (error) {
          _logger.debug('could not save the queue: $error');
        }
      }
    } finally {
      _saving = null;
    }
  }
}
