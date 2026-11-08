/// Rabolic product analytics for Flutter: events, screens, sessions,
/// lifecycle and identity for iOS, Android and the web.
///
/// Start with [Rabolic.init], then call [Rabolic.track].
library;

import 'src/rabolic.dart';

export 'src/client.dart' show RabolicClient;
export 'src/config.dart' show RabolicConfig, RabolicConsent, defaultRabolicHost;
export 'src/navigator_observer.dart'
    show RabolicNavigatorObserver, RouteFilter, ScreenNameExtractor;
export 'src/rabolic.dart' show Rabolic;
export 'src/version.dart' show libraryVersion;
