import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'file_queue_store.dart';
import 'key_value_store.dart';
import 'queue_store.dart';

/// The queue store for iOS and Android: a file under application support.
QueueStore createDefaultQueueStore(KeyValueStore keyValueStore) =>
    FileQueueStore(() async {
      final support = await getApplicationSupportDirectory();
      return Directory('${support.path}${Platform.pathSeparator}rabolic');
    });
