import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/src/validation.dart';

import 'support/harness.dart';

enum Plan { pro }

void main() {
  group('event names', () {
    test('accepts snake_case names', () {
      expect(eventNameProblem('workout_started'), isNull);
    });

    test('rejects empty, long, control-character and \$ names', () {
      expect(eventNameProblem(''), isNotNull);
      expect(eventNameProblem('a' * 201), isNotNull);
      expect(eventNameProblem('a' * 200), isNull);
      expect(eventNameProblem('tab\there'), isNotNull);
      expect(eventNameProblem(r'$purchase'), isNotNull);
      expect(eventNameProblem(r'$screen', allowReserved: true), isNull);
    });
  });

  group('sanitizeProperties', () {
    final problems = <String>[];
    setUp(problems.clear);

    test('keeps JSON values and converts DateTime, Enum and Uri', () {
      final result = sanitizeProperties({
        's': 'x',
        'i': 1,
        'd': 1.5,
        'b': true,
        'n': null,
        'list': [1, 'a'],
        'map': {'k': 'v'},
        'date': DateTime.utc(2026, 11, 8),
        'plan': Plan.pro,
        'uri': Uri.parse('https://rabolic.com/x'),
      }, problems.add);
      expect(result['date'], '2026-11-08T00:00:00.000Z');
      expect(result['plan'], 'pro');
      expect(result['uri'], 'https://rabolic.com/x');
      expect(result['list'], [1, 'a']);
      expect(problems, isEmpty);
    });

    test('drops non-JSON values and non-finite numbers', () {
      final result = sanitizeProperties({
        'obj': Object(),
        'nan': double.nan,
        'ok': 1,
      }, problems.add);
      expect(result, {'ok': 1});
      expect(problems, hasLength(2));
    });

    test('drops keys longer than 255 characters and past 255 per level', () {
      final input = <String, Object?>{
        'k' * 256: 1,
        for (var i = 0; i < 300; i++) 'key$i': i,
      };
      final result = sanitizeProperties(input, problems.add);
      expect(result, hasLength(255));
      expect(result.containsKey('k' * 256), isFalse);
    });

    test('limits nesting to 5 levels', () {
      final input = {
        'l2': {
          'l3': {
            'l4': {
              'l5': {
                'leaf': 1,
                'l6': {'too': 'deep'},
              },
            },
          },
        },
      };
      final result = sanitizeProperties(input, problems.add);
      final level5 = ((result['l2']! as Map)['l3']! as Map)['l4']! as Map;
      expect(level5['l5'], {'leaf': 1});
      expect(problems.single, contains('deeper than 5'));
    });
  });

  group('client input checks', () {
    test('invalid names and user ids are ignored without throwing', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('');
        h.client.track(r'$purchase');
        h.client.track('bad\nname');
        h.client.identify('');
        h.client.identify('u' * 256);
        h.client.screen('  ');
        async.flushMicrotasks();
        expect(h.queued, isEmpty);
      });
    });

    test('an event over 32 KB is dropped', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        h.client.track('big', properties: {'x': 'y' * (33 * 1024)});
        h.client.track('fits', properties: {'x': 'y' * (30 * 1024)});
        async.flushMicrotasks();
        expect(h.queuedNames, ['fits']);
      });
    });

    test('a throwing property value never reaches the app', () {
      runFake((async) {
        final h = startHarness(async, config: manualFlushConfig());
        expect(
          () => h.client.track('ok', properties: {'v': _Throwing()}),
          returnsNormally,
        );
        async.flushMicrotasks();
        expect(h.queuedNames, ['ok']);
      });
    });
  });
}

class _Throwing {
  @override
  String toString() => throw StateError('boom');
}
