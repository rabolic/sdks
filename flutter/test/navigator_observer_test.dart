import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';

import 'support/harness.dart';

List<String?> screenNames(Harness h) => [
  for (final e in h.events)
    if (e['event'] == r'$screen')
      (e['context']! as Map<String, Object?>)['screen_name'] as String?,
];

Future<Harness> pumpApp(
  WidgetTester tester, {
  ScreenNameExtractor? nameExtractor,
  RouteFilter? routeFilter,
}) async {
  final h = Harness(config: manualFlushConfig());
  await h.client.ready;
  final observer = RabolicNavigatorObserver(
    client: h.client,
    nameExtractor:
        nameExtractor ?? RabolicNavigatorObserver.defaultNameExtractor,
    routeFilter: routeFilter ?? RabolicNavigatorObserver.defaultRouteFilter,
  );
  await tester.pumpWidget(
    MaterialApp(
      navigatorObservers: [observer],
      initialRoute: '/',
      routes: {
        '/': (_) => const Text('home'),
        '/details': (_) => const Text('details'),
        '/settings': (_) => const Text('settings'),
      },
    ),
  );
  return h;
}

NavigatorState navigator(WidgetTester tester) =>
    tester.state<NavigatorState>(find.byType(Navigator));

void main() {
  testWidgets('push, replace and pop send \$screen for the visible page', (
    tester,
  ) async {
    final h = await pumpApp(tester);
    unawaited(navigator(tester).pushNamed('/details'));
    await tester.pumpAndSettle();
    unawaited(navigator(tester).pushReplacementNamed('/settings'));
    await tester.pumpAndSettle();
    navigator(tester).pop();
    await tester.pumpAndSettle();

    expect(screenNames(h), ['/', '/details', '/settings', '/']);
    final event = h.events.firstWhere((e) => e['event'] == r'$screen');
    expect(event['type'], 'screen');
    expect(event['properties'], {'name': '/'});
    await h.client.close();
  });

  testWidgets('dialogs are not screens, and closing one sends nothing', (
    tester,
  ) async {
    final h = await pumpApp(tester);
    unawaited(
      showDialog<void>(
        context: tester.element(find.text('home')),
        builder: (_) => const Text('dialog'),
      ),
    );
    await tester.pumpAndSettle();
    navigator(tester).pop();
    await tester.pumpAndSettle();
    expect(screenNames(h), ['/']);
    await h.client.close();
  });

  testWidgets('routes without a name are skipped', (tester) async {
    final h = await pumpApp(tester);
    unawaited(
      navigator(
        tester,
      ).push(MaterialPageRoute<void>(builder: (_) => const Text('x'))),
    );
    await tester.pumpAndSettle();
    expect(screenNames(h), ['/']);
    await h.client.close();
  });

  testWidgets('a custom name extractor and route filter are used', (
    tester,
  ) async {
    final h = await pumpApp(
      tester,
      nameExtractor: (settings) =>
          settings.name == '/' ? 'Home' : settings.name?.substring(1),
      routeFilter: (route) =>
          route is PageRoute && route.settings.name != '/settings',
    );
    unawaited(navigator(tester).pushNamed('/details'));
    await tester.pumpAndSettle();
    unawaited(navigator(tester).pushNamed('/settings'));
    await tester.pumpAndSettle();
    expect(screenNames(h), ['Home', 'details']);
    await h.client.close();
  });

  testWidgets('a throwing name extractor does not break navigation', (
    tester,
  ) async {
    final h = await pumpApp(
      tester,
      nameExtractor: (_) => throw StateError('boom'),
    );
    unawaited(navigator(tester).pushNamed('/details'));
    await tester.pumpAndSettle();
    expect(find.text('details'), findsOneWidget);
    expect(screenNames(h), isEmpty);
    await h.client.close();
  });

  testWidgets('works with the Pages API (go_router, auto_route)', (
    tester,
  ) async {
    final h = Harness(config: manualFlushConfig());
    await h.client.ready;
    final observer = RabolicNavigatorObserver(client: h.client);
    Widget app(List<Page<void>> pages) => MaterialApp(
      home: Navigator(
        observers: [observer],
        pages: pages,
        onDidRemovePage: (_) {},
      ),
    );
    // go_router names pages `state.name ?? state.path`.
    await tester.pumpWidget(
      app(const [MaterialPage(name: '/', child: Text('home'))]),
    );
    await tester.pumpWidget(
      app(const [
        MaterialPage(name: '/', child: Text('home')),
        MaterialPage(name: '/users/:id', child: Text('user')),
      ]),
    );
    await tester.pumpAndSettle();
    expect(screenNames(h), ['/', '/users/:id']);
    await h.client.close();
  });
}
