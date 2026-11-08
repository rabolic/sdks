import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/src/clock.dart';
import 'package:rabolic_flutter/src/ids.dart';
import 'package:rabolic_flutter/src/remote_config.dart';

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-([47])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

void main() {
  final ids = IdGenerator();

  test('uuidV4 has version 4 and the RFC variant', () {
    final values = List.generate(200, (_) => ids.uuidV4());
    for (final value in values) {
      expect(_uuid.firstMatch(value)?.group(1), '4');
    }
    expect(values.toSet(), hasLength(200));
  });

  test('uuidV7 has version 7 and embeds the time in milliseconds', () {
    final time = DateTime.utc(2026, 11, 8, 10, 0, 3, 120);
    final value = ids.uuidV7(time);
    expect(_uuid.firstMatch(value)?.group(1), '7');
    expect(uuidV7Time(value), time);
  });

  test('uuidV7 sorts by creation time', () {
    final base = DateTime.utc(2026);
    final values = [
      for (var i = 0; i < 50; i++) ids.uuidV7(base.add(Duration(seconds: i))),
    ];
    expect([...values]..sort(), values);
  });

  test('timestamps are RFC 3339 UTC with exactly three fractional digits', () {
    expect(
      formatTimestamp(DateTime.utc(2026, 1, 2, 3, 4, 5, 6, 7)),
      '2026-01-02T03:04:05.006Z',
    );
    expect(
      formatTimestamp(DateTime.utc(2026, 11, 8, 10)),
      '2026-11-08T10:00:00.000Z',
    );
  });

  test('fnv1a32 matches the reference vectors', () {
    expect(fnv1a32(''), 0x811c9dc5);
    expect(fnv1a32('a'), 0xe40c292c);
    expect(fnv1a32('foobar'), 0xbf9cf968);
  });
}
