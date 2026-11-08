import 'dart:convert';
import 'dart:io';

import 'queue_store.dart';

/// [QueueStore] in a file, written atomically.
///
/// A save writes a temporary file and renames it over the queue file. A
/// rename within one directory is atomic on iOS and Android, so a crash
/// mid-save leaves either the old queue or the new one, never half of one.
class FileQueueStore implements QueueStore {
  /// Creates a store in the directory that [directory] returns.
  FileQueueStore(this.directory, {this.fileName = 'queue.jsonl'});

  /// Resolves the directory lazily, because `path_provider` is async.
  final Future<Directory> Function() directory;

  /// The queue file's name inside [directory].
  final String fileName;

  Future<File> _file(String name) async {
    final dir = await directory();
    if (!dir.existsSync()) await dir.create(recursive: true);
    return File('${dir.path}${Platform.pathSeparator}$name');
  }

  @override
  Future<List<String>> load() async {
    try {
      final file = await _file(fileName);
      if (!file.existsSync()) return <String>[];
      final text = utf8.decode(await file.readAsBytes(), allowMalformed: true);
      return const LineSplitter().convert(text);
    } on Object {
      return <String>[];
    }
  }

  @override
  Future<void> save(List<String> lines) async {
    final file = await _file(fileName);
    final temp = await _file('$fileName.tmp');
    await temp.writeAsString(lines.join('\n'), flush: true);
    await temp.rename(file.path);
  }
}
