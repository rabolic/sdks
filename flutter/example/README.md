# rabolic_flutter example

A two-screen app that initialises Rabolic, tracks screens with
`RabolicNavigatorObserver`, sends a custom event, and identifies and logs out
a user.

The platform folders aren't checked in. To run it:

```sh
flutter create . --platforms=ios,android,web
flutter run --dart-define=RABOLIC_KEY=rb_pub_your_key
```
