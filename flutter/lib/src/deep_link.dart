import 'validation.dart';

const Map<String, String> _utmFields = <String, String>{
  'utm_source': 'source',
  'utm_medium': 'medium',
  'utm_campaign': 'name',
  'utm_content': 'content',
  'utm_term': 'term',
};

const List<String> _clickIds = <String>['gclid', 'fbclid', 'ttclid', 'msclkid'];

Map<String, String> _query(Uri uri) {
  try {
    return uri.queryParameters;
  } on Object {
    // Malformed percent-encoding: treat the link as having no parameters.
    return const <String, String>{};
  }
}

/// The `context.campaign` object for [uri]'s utm and click-id parameters,
/// empty when it has none.
///
/// `click_id` names which click id is present (`gclid`, …), as the protocol
/// defines it; the click id's value itself isn't sent.
Map<String, String> campaignFromUri(Uri uri) {
  final query = _query(uri);
  final campaign = <String, String>{};
  for (final MapEntry(key: param, value: field) in _utmFields.entries) {
    final value = query[param]?.trim();
    if (value != null && value.isNotEmpty) {
      campaign[field] = truncate(value, Limits.shortText);
    }
  }
  for (final clickId in _clickIds) {
    if (query[clickId]?.isNotEmpty ?? false) {
      campaign['click_id'] = clickId;
      break;
    }
  }
  return campaign;
}

/// The web anonymous id carried by a link's `rb_aid` parameter, or `null`.
String? linkedAnonymousId(Uri uri) {
  final value = _query(uri)['rb_aid']?.trim();
  if (value == null ||
      value.isEmpty ||
      value.runes.length > Limits.anonymousId) {
    return null;
  }
  return value;
}
