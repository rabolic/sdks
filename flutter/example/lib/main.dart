import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rabolic_flutter/rabolic_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Not awaited: calls made before Rabolic has loaded are kept and sent.
  unawaited(
    Rabolic.init(
      const RabolicConfig(
        projectKey: String.fromEnvironment(
          'RABOLIC_KEY',
          defaultValue: 'rb_pub_example',
        ),
        debug: true,
      ),
    ),
  );
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Rabolic example',
      navigatorObservers: [RabolicNavigatorObserver()],
      initialRoute: HomeScreen.routeName,
      routes: {
        HomeScreen.routeName: (_) => const HomeScreen(),
        ProgramScreen.routeName: (_) => const ProgramScreen(),
      },
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  static const routeName = 'Home';

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? _userId;

  void _logIn() {
    const userId = 'usr_demo_1';
    Rabolic.identify(userId, traits: {'plan': 'trial'});
    setState(() => _userId = userId);
  }

  void _logOut() {
    Rabolic.reset();
    setState(() => _userId = null);
  }

  @override
  Widget build(BuildContext context) {
    final userId = _userId;
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: 12,
          children: [
            Text(userId == null ? 'Not logged in' : 'Logged in as $userId'),
            if (userId == null)
              FilledButton(onPressed: _logIn, child: const Text('Log in'))
            else
              OutlinedButton(onPressed: _logOut, child: const Text('Log out')),
            FilledButton.tonal(
              onPressed: () =>
                  Navigator.pushNamed(context, ProgramScreen.routeName),
              child: const Text('Open program'),
            ),
          ],
        ),
      ),
    );
  }
}

class ProgramScreen extends StatelessWidget {
  const ProgramScreen({super.key});

  static const routeName = 'Program';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Strength 30')),
      body: Center(
        child: FilledButton(
          onPressed: () => Rabolic.track(
            'workout_started',
            properties: {'program_id': 'strength-30'},
          ),
          child: const Text('Start workout'),
        ),
      ),
    );
  }
}
