/// Gzips [bytes]. Returns `null` where gzip isn't available: the web, where
/// the browser can't set `Content-Encoding` on a request it compresses
/// itself and `dart:io` doesn't exist.
List<int>? gzipBytes(List<int> bytes) => null;
