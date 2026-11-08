import 'package:flutter/foundation.dart';

/// Where log lines go. Injected so tests can read them.
typedef LogSink = void Function(String line);

/// Console logging for the SDK.
///
/// [debug] lines appear only with `RabolicConfig.debug` on. [error] lines
/// also appear in debug builds of the app, because a wrong key or a
/// malformed batch should be visible during development even without
/// `debug: true`.
///
/// The project key is masked in every line, as a safety net: no code path
/// should log it in the first place.
class RabolicLogger {
  /// Creates a logger that masks [projectKey].
  RabolicLogger({
    required this.verbose,
    required String projectKey,
    LogSink? sink,
  }) : _projectKey = projectKey,
       _sink = sink ?? debugPrint;

  /// Whether `debug: true` was configured.
  final bool verbose;
  final String _projectKey;
  final LogSink _sink;
  final Set<String> _onceKeys = <String>{};

  /// Logs [message] when [verbose] is on.
  void debug(String message) {
    if (verbose) _write(message);
  }

  /// Logs [message] when [verbose] is on or the app is a debug build.
  void error(String message) {
    if (verbose || kDebugMode) _write(message);
  }

  /// Like [error], but only the first time for [key].
  void errorOnce(String key, String message) {
    if (_onceKeys.add(key)) error(message);
  }

  void _write(String message) {
    var line = '[Rabolic] $message';
    if (_projectKey.isNotEmpty) {
      line = line.replaceAll(_projectKey, '<project key>');
    }
    _sink(line);
  }
}
