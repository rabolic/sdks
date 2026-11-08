import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'clock.dart';
import 'gzip.dart';
import 'platform.dart';
import 'queue.dart';
import 'version.dart';

/// What the SDK should do with a batch after a request (protocol §1).
enum BatchOutcome {
  /// 2xx: the batch was received. Remove it.
  accepted,

  /// 400: the envelope was malformed. Drop the batch, don't retry.
  invalid,

  /// Another 4xx. Drop the batch, don't retry.
  rejected,

  /// 401: the key is invalid. Stop sending, keep the queue.
  unauthorized,

  /// 413: split the batch in half and retry each half.
  tooLarge,

  /// 429: retry after [BatchResponse.retryAfter].
  rateLimited,

  /// 5xx, timeout or network error: retry with backoff.
  retry,
}

/// The result of sending one batch.
class BatchResponse {
  /// Creates a response.
  const BatchResponse(
    this.outcome, {
    this.statusCode,
    this.retryAfter,
    this.body,
  });

  /// What to do with the batch.
  final BatchOutcome outcome;

  /// The HTTP status, or `null` after a network error or timeout.
  final int? statusCode;

  /// The `Retry-After` delay of a 429, when the header was valid.
  final Duration? retryAfter;

  /// The decoded JSON body, when there was one.
  final Map<String, Object?>? body;
}

/// The result of fetching remote config.
class ConfigResponse {
  /// Creates a response.
  const ConfigResponse({this.statusCode, this.body});

  /// The HTTP status, or `null` after a network error or timeout.
  final int? statusCode;

  /// The decoded JSON object of a 200 response.
  final Map<String, Object?>? body;
}

/// Talks to the ingest service over `package:http`.
class Transport {
  /// Creates a transport.
  Transport({
    required http.Client client,
    required String host,
    required String projectKey,
    required RabolicPlatform platform,
    required Clock clock,
    this.timeout = const Duration(seconds: 10),
  }) : _client = client,
       _host = host.endsWith('/') ? host.substring(0, host.length - 1) : host,
       _projectKey = projectKey,
       _isWeb = platform == RabolicPlatform.web,
       _clock = clock;

  /// Bodies larger than this are gzipped (outside the web).
  static const int gzipThresholdBytes = 1024;

  final http.Client _client;
  final String _host;
  final String _projectKey;
  final bool _isWeb;
  final Clock _clock;

  /// The per-request timeout.
  final Duration timeout;

  /// Sends [events] as one batch to `POST /v1/batch`.
  ///
  /// `sent_at` is set here, when the request goes out, so a retried batch
  /// carries the time of the retry.
  Future<BatchResponse> sendBatch(List<QueuedEvent> events) async {
    final body = _envelope(events);
    // Browsers send the key in the body with a text/plain content type, so
    // the request is "simple" and needs no CORS preflight.
    final headers = <String, String>{
      'Content-Type': _isWeb ? 'text/plain;charset=UTF-8' : 'application/json',
      if (!_isWeb) 'Authorization': 'Bearer $_projectKey',
    };
    List<int> bytes = utf8.encode(body);
    if (!_isWeb && bytes.length > gzipThresholdBytes) {
      final compressed = gzipBytes(bytes);
      if (compressed != null) {
        bytes = compressed;
        headers['Content-Encoding'] = 'gzip';
      }
    }

    final http.Response response;
    try {
      response = await _client
          .post(Uri.parse('$_host/v1/batch'), headers: headers, body: bytes)
          .timeout(timeout);
    } on Object {
      // Timeouts, socket errors and http.ClientException all mean "retry".
      return const BatchResponse(BatchOutcome.retry);
    }

    final status = response.statusCode;
    final json = _decodeObject(response.body);
    final outcome = switch (status) {
      >= 200 && < 300 => BatchOutcome.accepted,
      400 => BatchOutcome.invalid,
      401 => BatchOutcome.unauthorized,
      // A 408 is a timeout reported by a proxy, so it is retried like one.
      408 => BatchOutcome.retry,
      413 => BatchOutcome.tooLarge,
      429 => BatchOutcome.rateLimited,
      >= 400 && < 500 => BatchOutcome.rejected,
      _ => BatchOutcome.retry,
    };
    return BatchResponse(
      outcome,
      statusCode: status,
      retryAfter: status == 429 ? _retryAfter(response.headers) : null,
      body: json,
    );
  }

  /// Fetches `GET /v1/config`.
  Future<ConfigResponse> fetchConfig() async {
    final uri = Uri.parse(
      '$_host/v1/config',
    ).replace(queryParameters: <String, String>{'key': _projectKey});
    try {
      final response = await _client.get(uri).timeout(timeout);
      return ConfigResponse(
        statusCode: response.statusCode,
        body: response.statusCode == 200 ? _decodeObject(response.body) : null,
      );
    } on Object {
      return const ConfigResponse();
    }
  }

  String _envelope(List<QueuedEvent> events) {
    final buffer = StringBuffer('{');
    if (_isWeb) buffer.write('"key":${jsonEncode(_projectKey)},');
    buffer
      ..write('"sent_at":"${formatTimestamp(_clock())}",')
      ..write('"library":{"name":"$libraryName","version":"$libraryVersion"},')
      ..write('"events":[')
      ..writeAll(events.map((e) => e.json), ',')
      ..write(']}');
    return buffer.toString();
  }

  static Duration? _retryAfter(Map<String, String> headers) {
    final value = headers['retry-after'];
    if (value == null) return null;
    final seconds = num.tryParse(value.trim());
    if (seconds == null || seconds < 0) return null;
    return Duration(milliseconds: (seconds * 1000).round());
  }

  static Map<String, Object?>? _decodeObject(String body) {
    if (body.isEmpty) return null;
    try {
      final decoded = jsonDecode(body);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      return null;
    }
  }
}
