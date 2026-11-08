import 'dart:io';

/// Gzips [bytes]. Returns `null` where gzip isn't available.
List<int>? gzipBytes(List<int> bytes) => gzip.encode(bytes);
