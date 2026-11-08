import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/src/deep_link.dart';

import 'support/harness.dart';

void main() {
  test('sends \$deep_link with url, linked_anonymous_id and campaign', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      h.client.handleDeepLink(
        Uri.parse(
          'acmefit://program/strength-30?rb_aid=4f1c-web-id'
          '&utm_source=google&utm_medium=cpc&utm_campaign=q4'
          '&utm_content=ad1&utm_term=fitness&gclid=abc',
        ),
      );
      async.flushMicrotasks();
      final event = h.queued.single;
      expect(event['type'], 'track');
      expect(event['event'], r'$deep_link');
      expect(event['properties'], {
        'url':
            'acmefit://program/strength-30?rb_aid=4f1c-web-id'
            '&utm_source=google&utm_medium=cpc&utm_campaign=q4'
            '&utm_content=ad1&utm_term=fitness&gclid=abc',
        'linked_anonymous_id': '4f1c-web-id',
      });
      final context = event['context']! as Map<String, Object?>;
      expect(context['campaign'], {
        'source': 'google',
        'medium': 'cpc',
        'name': 'q4',
        'content': 'ad1',
        'term': 'fitness',
        'click_id': 'gclid',
      });
    });
  });

  test('a link without parameters sends only the url', () {
    runFake((async) {
      final h = startHarness(async, config: manualFlushConfig());
      h.client.handleDeepLink(Uri.parse('https://acme.fit/open'));
      async.flushMicrotasks();
      final event = h.queued.single;
      expect(event['properties'], {'url': 'https://acme.fit/open'});
      expect((event['context']! as Map).containsKey('campaign'), isFalse);
    });
  });

  test('malformed query strings and over-long rb_aid are ignored', () {
    expect(campaignFromUri(Uri.parse('x://y?utm_source=%E0%A4%A')), isEmpty);
    expect(linkedAnonymousId(Uri.parse('x://y?rb_aid=${'a' * 129}')), isNull);
    expect(linkedAnonymousId(Uri.parse('x://y?rb_aid=')), isNull);
  });

  test('the first click id present wins', () {
    expect(campaignFromUri(Uri.parse('x://y?msclkid=1&fbclid=2')), {
      'click_id': 'fbclid',
    });
  });
}
