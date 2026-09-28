import Foundation
import SQLCipher

let SQLITE_TRANSIENT = unsafeBitCast(-1 as Int, to: sqlite3_destructor_type?.self)

struct File {
  let path: String
  let name: String
  let is_folder: Bool
}

class FileSearchIndex {
  static let shared = FileSearchIndex()
  
  private var db: OpaquePointer?
  private let dbPath: String
  private let queue = DispatchQueue(label: "com.ospfranco.sol.filesearch.index")
  
  init() {
    self.dbPath = LocalVault.vaultDirectory().appendingPathComponent("filesearch.db").path
    
    self.initializeDatabase()
  }
  
  private func initializeDatabase() {
    var db: OpaquePointer?
    guard let key = try? LocalVault.key(), key.count == 32 else { return }
    do { try FileManager.default.createDirectory(at: LocalVault.vaultDirectory(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch { return }
    if sqlite3_open(dbPath, &db) == SQLITE_OK,
       key.withUnsafeBytes({ sqlite3_key(db, $0.baseAddress, Int32($0.count)) }) == SQLITE_OK {
      self.db = db
      var verification: OpaquePointer?
      guard sqlite3_prepare_v2(db, "PRAGMA cipher_version", -1, &verification, nil) == SQLITE_OK,
            sqlite3_step(verification) == SQLITE_ROW,
            sqlite3_column_text(verification, 0) != nil else { sqlite3_finalize(verification); sqlite3_close(db); self.db = nil; return }
      sqlite3_finalize(verification)
      guard sqlite3_exec(db, "SELECT count(*) FROM sqlite_master; PRAGMA temp_store=MEMORY;", nil, nil, nil) == SQLITE_OK else { sqlite3_close(db); self.db = nil; return }
      sqlite3_exec(db, "PRAGMA cipher_memory_security=ON;", nil, nil, nil)
      
      let createTableSQL = """
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          is_folder INTEGER NOT NULL,
          parent_path TEXT,
          indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_name ON files(name);
        CREATE INDEX IF NOT EXISTS idx_parent ON files(parent_path);
      """
      
      var errorMessage: UnsafeMutablePointer<CChar>? = nil
      if sqlite3_exec(db, createTableSQL, nil, nil, &errorMessage) != SQLITE_OK {
        if let error = errorMessage {
          sqlite3_free(error)
        }
      }
    }
  }
  
  func indexPath(_ basePath: NSString) {
    queue.async { [weak self] in
      guard let self = self, let db = self.db else { return }
      self._indexPathIterative(basePath as String, db: db)
    }
  }

  func indexPaths(_ paths: [String]) {
    queue.async { [weak self] in
      guard let self = self, let db = self.db else { return }
      for path in paths {
        self._indexPathIterative(path, db: db)
      }
    }
  }

  func hasIndexedContent() -> Bool {
    var result = false
    queue.sync { [weak self] in
      guard let self = self, let db = self.db else { return }
      var statement: OpaquePointer?
      if sqlite3_prepare_v2(db, "SELECT 1 FROM files LIMIT 1;", -1, &statement, nil) == SQLITE_OK {
        result = sqlite3_step(statement) == SQLITE_ROW
        sqlite3_finalize(statement)
      }
    }
    return result
  }

  func removeIndexedPath(_ basePath: String) {
    queue.async { [weak self] in
      guard let self = self, let db = self.db else { return }
      let deleteSQL = "DELETE FROM files WHERE path LIKE ? || '%';"
      var statement: OpaquePointer?
      if sqlite3_prepare_v2(db, deleteSQL, -1, &statement, nil) == SQLITE_OK {
        sqlite3_bind_text(statement, 1, basePath, -1, SQLITE_TRANSIENT)
        sqlite3_step(statement)
        sqlite3_finalize(statement)
      }
    }
  }

  func upsertFile(path: String, name: String, isFolder: Bool, parentPath: String) {
    queue.async { [weak self] in
      guard let self = self, let db = self.db else { return }
      self._insertOrUpdateFile(path: path, name: name, isFolder: isFolder, parentPath: parentPath, db: db)
    }
  }

  func removeFile(atPath path: String) {
    queue.async { [weak self] in
      guard let self = self, let db = self.db else { return }
      var statement: OpaquePointer?
      if sqlite3_prepare_v2(db, "DELETE FROM files WHERE path = ?;", -1, &statement, nil) == SQLITE_OK {
        sqlite3_bind_text(statement, 1, path, -1, SQLITE_TRANSIENT)
        sqlite3_step(statement)
        sqlite3_finalize(statement)
      }
    }
  }
  
  private func _indexPathIterative(_ rootPath: String, db: OpaquePointer) {
    let fileManager = FileManager.default
    let batchSize = 200
    var pendingDirs: [String] = [rootPath]
    var batchCount = 0

    sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)

    while !pendingDirs.isEmpty {
      let currentDir = pendingDirs.removeFirst()

      guard let dirContents = try? fileManager.contentsOfDirectory(atPath: currentDir) else {
        continue
      }

      for item in dirContents {
        // Skip hidden files and folders
        if item.hasPrefix(".") {
          continue
        }

        let fullPath = (currentDir as NSString).appendingPathComponent(item)
        var isDir: ObjCBool = false

        guard fileManager.fileExists(atPath: fullPath, isDirectory: &isDir) else {
          continue
        }

        self._insertOrUpdateFile(path: fullPath, name: item, isFolder: isDir.boolValue, parentPath: currentDir, db: db)
        batchCount += 1

        if isDir.boolValue {
          pendingDirs.append(fullPath)
        }

        if batchCount >= batchSize {
          sqlite3_exec(db, "COMMIT;", nil, nil, nil)
          sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
          batchCount = 0
        }
      }
    }

    sqlite3_exec(db, "COMMIT;", nil, nil, nil)
  }

  private func _insertOrUpdateFile(path: String, name: String, isFolder: Bool, parentPath: String, db: OpaquePointer) {
    let insertSQL = """
      INSERT OR REPLACE INTO files (path, name, is_folder, parent_path)
      VALUES (?, ?, ?, ?)
    """
    
    var statement: OpaquePointer?
    
    if sqlite3_prepare_v2(db, insertSQL, -1, &statement, nil) == SQLITE_OK {
      sqlite3_bind_text(statement, 1, path, -1, SQLITE_TRANSIENT)
      sqlite3_bind_text(statement, 2, name, -1, SQLITE_TRANSIENT)
      sqlite3_bind_int(statement, 3, isFolder ? 1 : 0)
      sqlite3_bind_text(statement, 4, parentPath, -1, SQLITE_TRANSIENT)
      
      sqlite3_step(statement)
      sqlite3_finalize(statement)
    }
  }
  
  func searchFiles(query: String) -> [File] {
    if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return []
    }

    var results: [File] = []
    
    queue.sync { [weak self] in
      guard let self = self, let db = self.db else { return }
      
      let searchSQL = "SELECT path, name, is_folder FROM files LIMIT 1000"
      
      var statement: OpaquePointer?
      
      if sqlite3_prepare_v2(db, searchSQL, -1, &statement, nil) == SQLITE_OK {
        while sqlite3_step(statement) == SQLITE_ROW {
          if let cPath = sqlite3_column_text(statement, 0),
             let cName = sqlite3_column_text(statement, 1) {
            let path = String(cString: cPath)
            let name = String(cString: cName)
            let isFolder = sqlite3_column_int(statement, 2) != 0
            
            // Apply fuzzy matching
            let score = (name as NSString).scoreAgainst(query)
            if score > 0.5 {
              results.append(File(
                path: path,
                name: name,
                is_folder: isFolder
              ))
            }
          }
        }
        
        sqlite3_finalize(statement)
      }
    }
    
    return results.sorted { $0.name < $1.name }
  }
  
  func clearIndex() {
    queue.async { [weak self] in
      guard let self = self, let db = self.db else { return }
      sqlite3_exec(db, "DELETE FROM files;", nil, nil, nil)
    }
  }
  
  deinit {
    if let db = db {
      sqlite3_close(db)
    }
  }
}
