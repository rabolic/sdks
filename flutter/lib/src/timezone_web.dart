import 'dart:js_interop';

@JS('Intl.DateTimeFormat')
extension type _DateTimeFormat._(JSObject _) implements JSObject {
  external factory _DateTimeFormat();
  external _ResolvedOptions resolvedOptions();
}

extension type _ResolvedOptions._(JSObject _) implements JSObject {
  external String? get timeZone;
}

/// The browser's IANA time zone name, from `Intl.DateTimeFormat`.
String? ianaTimeZone() {
  try {
    return _DateTimeFormat().resolvedOptions().timeZone;
  } on Object {
    return null;
  }
}
