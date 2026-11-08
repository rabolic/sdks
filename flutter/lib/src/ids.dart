import 'dart:math';

/// Generates the UUIDs the protocol uses.
///
/// Anonymous ids are UUIDv4. Event and session ids are UUIDv7, whose first
/// 48 bits are the Unix time in milliseconds, so ids sort by creation time
/// and a session id carries its start time.
class IdGenerator {
  /// Creates a generator. [random] defaults to [Random.secure].
  IdGenerator([Random? random]) : _random = random ?? Random.secure();

  final Random _random;

  /// A random (version 4) UUID.
  String uuidV4() {
    final bytes = _randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return _format(bytes);
  }

  /// A time-ordered (version 7) UUID for [time] (RFC 9562 §5.7).
  String uuidV7(DateTime time) {
    final bytes = _randomBytes(16);
    // Arithmetic rather than bit shifts: on the web, bitwise operators
    // truncate to 32 bits and the timestamp needs 48.
    var millis = time.millisecondsSinceEpoch;
    for (var i = 5; i >= 0; i--) {
      bytes[i] = millis % 256;
      millis ~/= 256;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return _format(bytes);
  }

  List<int> _randomBytes(int length) =>
      List<int>.generate(length, (_) => _random.nextInt(256));

  static String _format(List<int> bytes) {
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

/// The millisecond timestamp embedded in a UUIDv7.
DateTime uuidV7Time(String uuid) {
  final hex = uuid.replaceAll('-', '').substring(0, 12);
  return DateTime.fromMillisecondsSinceEpoch(
    int.parse(hex, radix: 16),
    isUtc: true,
  );
}
