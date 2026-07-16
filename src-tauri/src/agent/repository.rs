use crate::workspace::{WorkspaceDocument, WorkspaceOperation};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const MAX_DISK_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;
const JOURNAL_QUEUE_CAPACITY: usize = 4096;

#[derive(Debug)]
pub enum WorkspaceRepoError {
    NotFound(String),
    AlreadyExists(String),
    RevisionConflict { expected: u64, actual: u64 },
    Invalid(String),
    Database(String),
}

impl std::fmt::Display for WorkspaceRepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "workspace not found: {id}"),
            Self::AlreadyExists(id) => write!(f, "workspace already exists: {id}"),
            Self::RevisionConflict { expected, actual } => {
                write!(
                    f,
                    "workspace revision conflict: expected {expected}, actual {actual}"
                )
            }
            Self::Invalid(message) => write!(f, "invalid workspace: {message}"),
            Self::Database(message) => write!(f, "workspace database: {message}"),
        }
    }
}

impl std::error::Error for WorkspaceRepoError {}

enum JournalOp {
    Append {
        session_id: String,
        start_seq: u64,
        end_seq: u64,
        data: Vec<u8>,
    },
    Checkpoint {
        session_id: String,
        through_seq: u64,
        ansi: Vec<u8>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    LoadOutput {
        session_id: String,
        reply: oneshot::Sender<Result<Vec<PersistedOutputChunk>, String>>,
    },
    PurgeSessions {
        session_ids: Vec<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    PurgePanes {
        workspace_id: String,
        pane_ids: Vec<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    PurgeWorkspace {
        workspace_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedOutputChunk {
    pub start_seq: u64,
    pub data: Vec<u8>,
}

pub struct AgentRepository {
    path: PathBuf,
    conn: Mutex<Connection>,
    journal_tx: mpsc::Sender<JournalOp>,
    journal_dropped_chunks: AtomicU64,
}

pub struct RepositoryDiagnostics {
    pub database_bytes: u64,
    pub journal_bytes: u64,
    pub checkpoint_bytes: u64,
    pub dropped_journal_chunks: u64,
}

impl AgentRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create agent data dir {}: {e}", parent.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        let conn = open_connection(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        init_schema(&conn)?;
        // A daemon restart cannot recover the old PTY master. Preserve its
        // checkpoint, but never advertise a stale pid as running.
        conn.execute(
            "UPDATE sessions SET state = 'lost', updated_at = ?1 WHERE state = 'running'",
            params![now_millis()],
        )
        .map_err(|e| e.to_string())?;

        let (journal_tx, journal_rx) = mpsc::channel(JOURNAL_QUEUE_CAPACITY);
        let writer_path = path.clone();
        std::thread::Builder::new()
            .name("yterminal-agent-journal".into())
            .spawn(move || journal_writer(writer_path, journal_rx))
            .map_err(|e| format!("spawn journal writer: {e}"))?;

        Ok(Self {
            path,
            conn: Mutex::new(conn),
            journal_tx,
            journal_dropped_chunks: AtomicU64::new(0),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn device_id(&self) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if let Some(id) = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'device_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('device_id', ?1)",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_session_spawn(
        &self,
        session_id: &str,
        workspace_id: &str,
        pane_id: &str,
        pid: Option<u32>,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO sessions
             (id, workspace_id, pane_id, state, pid, cwd, cols, rows, head_seq, exit_code, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, 0, NULL, ?8, ?8)",
            params![
                session_id,
                workspace_id,
                pane_id,
                pid,
                cwd,
                cols as u32,
                rows as u32,
                now_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn enqueue_output(
        &self,
        session_id: String,
        start_seq: u64,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let end_seq = start_seq.saturating_add(data.len() as u64);
        let result = self.journal_tx.try_send(JournalOp::Append {
            session_id,
            start_seq,
            end_seq,
            data,
        });
        if let Err(error) = result {
            self.journal_dropped_chunks.fetch_add(1, Ordering::Relaxed);
            return Err(format!("journal queue unavailable: {error}"));
        }
        Ok(())
    }

    pub async fn save_checkpoint(
        &self,
        session_id: String,
        through_seq: u64,
        ansi: Vec<u8>,
    ) -> Result<(), String> {
        let (reply, wait) = oneshot::channel();
        self.journal_tx
            .send(JournalOp::Checkpoint {
                session_id,
                through_seq,
                ansi,
                reply,
            })
            .await
            .map_err(|_| "journal writer stopped".to_string())?;
        wait.await
            .map_err(|_| "journal checkpoint writer stopped".to_string())?
    }

    /// Read the retained on-disk journal after all append operations queued
    /// before this call. Routing the read through the writer thread gives an
    /// attach a stable prefix even while PTY output is arriving concurrently.
    pub async fn load_output_chunks(
        &self,
        session_id: String,
    ) -> Result<Vec<PersistedOutputChunk>, String> {
        let (reply, wait) = oneshot::channel();
        self.journal_tx
            .send(JournalOp::LoadOutput { session_id, reply })
            .await
            .map_err(|_| "journal writer stopped".to_string())?;
        wait.await
            .map_err(|_| "journal replay reader stopped".to_string())?
    }

    pub async fn purge_sessions(&self, session_ids: Vec<String>) -> Result<(), String> {
        if session_ids.is_empty() {
            return Ok(());
        }
        let (reply, wait) = oneshot::channel();
        self.journal_tx
            .send(JournalOp::PurgeSessions { session_ids, reply })
            .await
            .map_err(|_| "journal writer stopped".to_string())?;
        wait.await
            .map_err(|_| "journal purge writer stopped".to_string())?
    }

    pub async fn purge_panes(
        &self,
        workspace_id: String,
        pane_ids: Vec<String>,
    ) -> Result<(), String> {
        if pane_ids.is_empty() {
            return Ok(());
        }
        let (reply, wait) = oneshot::channel();
        self.journal_tx
            .send(JournalOp::PurgePanes {
                workspace_id,
                pane_ids,
                reply,
            })
            .await
            .map_err(|_| "journal writer stopped".to_string())?;
        wait.await
            .map_err(|_| "journal pane purge writer stopped".to_string())?
    }

    pub async fn purge_workspace(&self, workspace_id: String) -> Result<(), String> {
        let (reply, wait) = oneshot::channel();
        self.journal_tx
            .send(JournalOp::PurgeWorkspace {
                workspace_id,
                reply,
            })
            .await
            .map_err(|_| "journal writer stopped".to_string())?;
        wait.await
            .map_err(|_| "journal workspace purge writer stopped".to_string())?
    }

    pub fn mark_exit(&self, session_id: &str, exit_code: u32) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET state='exited', exit_code=?2, updated_at=?3 WHERE id=?1",
            params![session_id, exit_code, now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn diagnostics(&self) -> Result<RepositoryDiagnostics, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let journal_bytes = conn
            .query_row(
                "SELECT COALESCE(SUM(length(data)), 0) FROM output_chunks",
                [],
                |row| row.get::<_, u64>(0),
            )
            .map_err(|e| e.to_string())?;
        let checkpoint_bytes = conn
            .query_row(
                "SELECT COALESCE(SUM(length(ansi)), 0) FROM checkpoints",
                [],
                |row| row.get::<_, u64>(0),
            )
            .map_err(|e| e.to_string())?;
        let database_bytes = [
            self.path.clone(),
            self.path.with_extension("db-wal"),
            self.path.with_extension("db-shm"),
        ]
        .into_iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum();
        Ok(RepositoryDiagnostics {
            database_bytes,
            journal_bytes,
            checkpoint_bytes,
            dropped_journal_chunks: self.journal_dropped_chunks.load(Ordering::Relaxed),
        })
    }

    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceDocument>, WorkspaceRepoError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let mut statement = conn
            .prepare("SELECT document_json FROM workspaces ORDER BY updated_at, id")
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let mut workspaces = Vec::new();
        for row in rows {
            let json = row.map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
            workspaces.push(
                serde_json::from_str(&json)
                    .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?,
            );
        }
        Ok(workspaces)
    }

    pub fn get_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceDocument, WorkspaceRepoError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        load_workspace(&conn, workspace_id)
    }

    pub fn import_workspaces(
        &self,
        mut workspaces: Vec<WorkspaceDocument>,
    ) -> Result<Vec<WorkspaceDocument>, WorkspaceRepoError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        for workspace in &mut workspaces {
            workspace.validate().map_err(WorkspaceRepoError::Invalid)?;
            if workspace.revision == 0 {
                workspace.revision = 1;
            }
            let json = serde_json::to_string(workspace)
                .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
            // Existing agent state wins: import is an idempotent one-time
            // migration, never a last-write-wins overwrite on every startup.
            tx.execute(
                "INSERT OR IGNORE INTO workspaces(id, revision, document_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![workspace.id, workspace.revision, json, now_millis()],
            )
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        }
        tx.commit()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        // `list_workspaces` locks the same connection; release the transaction
        // guard explicitly instead of relying on end-of-scope drop.
        drop(conn);
        self.list_workspaces()
    }

    pub fn create_workspace(
        &self,
        mut workspace: WorkspaceDocument,
    ) -> Result<WorkspaceDocument, WorkspaceRepoError> {
        workspace.validate().map_err(WorkspaceRepoError::Invalid)?;
        workspace.revision = 1;
        let json = serde_json::to_string(&workspace)
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        match conn.execute(
            "INSERT INTO workspaces(id, revision, document_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![workspace.id, workspace.revision, json, now_millis()],
        ) {
            Ok(_) => Ok(workspace),
            Err(error) if error.to_string().contains("UNIQUE constraint") => {
                Err(WorkspaceRepoError::AlreadyExists(workspace.id))
            }
            Err(error) => Err(WorkspaceRepoError::Database(error.to_string())),
        }
    }

    pub fn apply_workspace_operation(
        &self,
        workspace_id: &str,
        base_revision: u64,
        operation: WorkspaceOperation,
    ) -> Result<WorkspaceDocument, WorkspaceRepoError> {
        self.apply_workspace_operation_inner(workspace_id, Some(base_revision), operation)
    }

    pub fn apply_workspace_operation_internal(
        &self,
        workspace_id: &str,
        operation: WorkspaceOperation,
    ) -> Result<WorkspaceDocument, WorkspaceRepoError> {
        self.apply_workspace_operation_inner(workspace_id, None, operation)
    }

    fn apply_workspace_operation_inner(
        &self,
        workspace_id: &str,
        base_revision: Option<u64>,
        operation: WorkspaceOperation,
    ) -> Result<WorkspaceDocument, WorkspaceRepoError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let mut workspace = load_workspace(&tx, workspace_id)?;
        if let Some(expected) = base_revision {
            if workspace.revision != expected {
                return Err(WorkspaceRepoError::RevisionConflict {
                    expected,
                    actual: workspace.revision,
                });
            }
        }
        let before = workspace.clone();
        workspace
            .apply(operation)
            .map_err(WorkspaceRepoError::Invalid)?;
        if workspace == before {
            return Ok(workspace);
        }
        workspace.revision = workspace.revision.saturating_add(1);
        let json = serde_json::to_string(&workspace)
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        tx.execute(
            "UPDATE workspaces SET revision=?2, document_json=?3, updated_at=?4 WHERE id=?1",
            params![workspace.id, workspace.revision, json, now_millis()],
        )
        .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        tx.commit()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        Ok(workspace)
    }

    pub fn delete_workspace(&self, workspace_id: &str) -> Result<(), WorkspaceRepoError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        let changed = conn
            .execute("DELETE FROM workspaces WHERE id=?1", params![workspace_id])
            .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?;
        if changed == 0 {
            return Err(WorkspaceRepoError::NotFound(workspace_id.into()));
        }
        Ok(())
    }
}

fn load_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> Result<WorkspaceDocument, WorkspaceRepoError> {
    let json = conn
        .query_row(
            "SELECT document_json FROM workspaces WHERE id=?1",
            params![workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| WorkspaceRepoError::Database(e.to_string()))?
        .ok_or_else(|| WorkspaceRepoError::NotFound(workspace_id.into()))?;
    serde_json::from_str(&json).map_err(|e| WorkspaceRepoError::Database(e.to_string()))
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path)
        .map_err(|e| format!("open agent database {}: {e}", path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sessions (
             id TEXT PRIMARY KEY,
             workspace_id TEXT NOT NULL,
             pane_id TEXT NOT NULL,
             state TEXT NOT NULL,
             pid INTEGER,
             cwd TEXT,
             cols INTEGER NOT NULL,
             rows INTEGER NOT NULL,
             head_seq INTEGER NOT NULL DEFAULT 0,
             exit_code INTEGER,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS output_chunks (
             session_id TEXT NOT NULL,
             start_seq INTEGER NOT NULL,
             end_seq INTEGER NOT NULL,
             data BLOB NOT NULL,
             PRIMARY KEY(session_id, start_seq)
         );
         CREATE TABLE IF NOT EXISTS checkpoints (
             session_id TEXT PRIMARY KEY,
             through_seq INTEGER NOT NULL,
             ansi BLOB NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspaces (
             id TEXT PRIMARY KEY,
             revision INTEGER NOT NULL,
             document_json TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| e.to_string())
}

fn journal_writer(path: PathBuf, mut rx: mpsc::Receiver<JournalOp>) {
    let conn = match open_connection(&path).and_then(|conn| {
        init_schema(&conn)?;
        Ok(conn)
    }) {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("yterminal-agent journal init failed: {e}");
            return;
        }
    };
    while let Some(op) = rx.blocking_recv() {
        match op {
            JournalOp::Append {
                session_id,
                start_seq,
                end_seq,
                data,
            } => {
                if let Err(e) = conn.execute(
                    "INSERT OR REPLACE INTO output_chunks(session_id, start_seq, end_seq, data)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![session_id, start_seq, end_seq, data],
                ) {
                    eprintln!("yterminal-agent journal append failed: {e}");
                    continue;
                }
                let _ = conn.execute(
                    "UPDATE sessions SET head_seq=?2, updated_at=?3 WHERE id=?1",
                    params![session_id, end_seq, now_millis()],
                );
                let keep_after = end_seq.saturating_sub(MAX_DISK_JOURNAL_BYTES);
                if keep_after > 0 {
                    let _ = conn.execute(
                        "DELETE FROM output_chunks WHERE session_id=?1 AND end_seq <= ?2",
                        params![session_id, keep_after],
                    );
                }
            }
            JournalOp::Checkpoint {
                session_id,
                through_seq,
                ansi,
                reply,
            } => {
                let result = (|| -> Result<(), String> {
                    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
                    tx.execute(
                        "INSERT OR REPLACE INTO checkpoints(session_id, through_seq, ansi, updated_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![session_id, through_seq, ansi, now_millis()],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.execute(
                        "DELETE FROM output_chunks WHERE session_id=?1 AND end_seq <= ?2",
                        params![session_id, through_seq],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.commit().map_err(|e| e.to_string())?;
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            JournalOp::LoadOutput { session_id, reply } => {
                let result = (|| -> Result<Vec<PersistedOutputChunk>, String> {
                    let mut statement = conn
                        .prepare(
                            "SELECT start_seq, data FROM output_chunks
                             WHERE session_id=?1 ORDER BY start_seq",
                        )
                        .map_err(|e| e.to_string())?;
                    let rows = statement
                        .query_map(params![session_id], |row| {
                            Ok(PersistedOutputChunk {
                                start_seq: row.get(0)?,
                                data: row.get(1)?,
                            })
                        })
                        .map_err(|e| e.to_string())?;
                    let mut chunks = Vec::new();
                    for row in rows {
                        chunks.push(row.map_err(|e| e.to_string())?);
                    }
                    Ok(chunks)
                })();
                let _ = reply.send(result);
            }
            JournalOp::PurgeSessions { session_ids, reply } => {
                let result = (|| -> Result<(), String> {
                    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
                    purge_session_ids(&tx, session_ids)?;
                    tx.commit().map_err(|e| e.to_string())
                })();
                let _ = reply.send(result);
            }
            JournalOp::PurgePanes {
                workspace_id,
                pane_ids,
                reply,
            } => {
                let result = (|| -> Result<(), String> {
                    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
                    let mut session_ids = Vec::new();
                    for pane_id in pane_ids {
                        let mut statement = tx
                            .prepare("SELECT id FROM sessions WHERE workspace_id=?1 AND pane_id=?2")
                            .map_err(|e| e.to_string())?;
                        let rows = statement
                            .query_map(params![workspace_id, pane_id], |row| {
                                row.get::<_, String>(0)
                            })
                            .map_err(|e| e.to_string())?;
                        for row in rows {
                            session_ids.push(row.map_err(|e| e.to_string())?);
                        }
                    }
                    purge_session_ids(&tx, session_ids)?;
                    tx.commit().map_err(|e| e.to_string())
                })();
                let _ = reply.send(result);
            }
            JournalOp::PurgeWorkspace {
                workspace_id,
                reply,
            } => {
                let result = (|| -> Result<(), String> {
                    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
                    let session_ids = {
                        let mut statement = tx
                            .prepare("SELECT id FROM sessions WHERE workspace_id=?1")
                            .map_err(|e| e.to_string())?;
                        let rows = statement
                            .query_map(params![workspace_id], |row| row.get::<_, String>(0))
                            .map_err(|e| e.to_string())?;
                        let mut ids = Vec::new();
                        for row in rows {
                            ids.push(row.map_err(|e| e.to_string())?);
                        }
                        ids
                    };
                    purge_session_ids(&tx, session_ids)?;
                    tx.commit().map_err(|e| e.to_string())
                })();
                let _ = reply.send(result);
            }
        }
    }
}

fn purge_session_ids(
    tx: &rusqlite::Transaction<'_>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    for session_id in session_ids {
        tx.execute(
            "DELETE FROM output_chunks WHERE session_id=?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM checkpoints WHERE session_id=?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM sessions WHERE id=?1", params![session_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{PaneTree, TabDocument};

    fn temp_db() -> PathBuf {
        std::env::temp_dir().join(format!("yterminal-agent-test-{}.db", Uuid::new_v4()))
    }

    #[test]
    fn device_id_is_stable() {
        let path = temp_db();
        let repo = AgentRepository::open(&path).unwrap();
        let first = repo.device_id().unwrap();
        drop(repo);
        let repo = AgentRepository::open(&path).unwrap();
        assert_eq!(repo.device_id().unwrap(), first);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn checkpoint_replaces_old_journal() {
        let path = temp_db();
        let repo = AgentRepository::open(&path).unwrap();
        repo.record_session_spawn("s", "w", "p", Some(1), Some("/tmp"), 80, 24)
            .unwrap();
        repo.enqueue_output("s".into(), 0, b"hello".to_vec())
            .unwrap();
        repo.save_checkpoint("s".into(), 5, b"snapshot".to_vec())
            .await
            .unwrap();
        let conn = Connection::open(&path).unwrap();
        let chunks: i64 = conn
            .query_row(
                "SELECT count(*) FROM output_chunks WHERE session_id='s'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(chunks, 0);
        let checkpoint: Vec<u8> = conn
            .query_row(
                "SELECT ansi FROM checkpoints WHERE session_id='s'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(checkpoint, b"snapshot");
        drop(repo);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn replay_read_is_ordered_after_queued_appends() {
        let path = temp_db();
        let repo = AgentRepository::open(&path).unwrap();
        repo.enqueue_output("s".into(), 0, b"abc".to_vec()).unwrap();
        repo.enqueue_output("s".into(), 3, b"def".to_vec()).unwrap();
        let chunks = repo.load_output_chunks("s".into()).await.unwrap();
        assert_eq!(
            chunks,
            vec![
                PersistedOutputChunk {
                    start_seq: 0,
                    data: b"abc".to_vec(),
                },
                PersistedOutputChunk {
                    start_seq: 3,
                    data: b"def".to_vec(),
                },
            ]
        );
        drop(repo);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn purge_sessions_is_ordered_after_queued_journal_writes() {
        let path = temp_db();
        let repo = AgentRepository::open(&path).unwrap();
        repo.record_session_spawn("s", "w", "p", Some(1), Some("/tmp"), 80, 24)
            .unwrap();
        repo.enqueue_output("s".into(), 0, b"orphan".to_vec())
            .unwrap();
        repo.purge_sessions(vec!["s".into()]).await.unwrap();
        let conn = Connection::open(&path).unwrap();
        for table in ["sessions", "output_chunks", "checkpoints"] {
            let count: i64 = conn
                .query_row(
                    &format!(
                        "SELECT count(*) FROM {table} WHERE {}='s'",
                        if table == "sessions" {
                            "id"
                        } else {
                            "session_id"
                        }
                    ),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "{table} retained session data");
        }
        drop(repo);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn purge_workspace_removes_all_owned_session_artifacts_only() {
        let path = temp_db();
        let repo = AgentRepository::open(&path).unwrap();
        for (session, workspace, pane) in [("s-owned", "w", "p"), ("s-other", "other", "p")] {
            repo.record_session_spawn(session, workspace, pane, Some(1), Some("/tmp"), 80, 24)
                .unwrap();
            repo.enqueue_output(session.into(), 0, b"output".to_vec())
                .unwrap();
            repo.save_checkpoint(session.into(), 0, b"checkpoint".to_vec())
                .await
                .unwrap();
        }

        repo.purge_workspace("w".into()).await.unwrap();
        let conn = Connection::open(&path).unwrap();
        for table in ["sessions", "output_chunks", "checkpoints"] {
            let id_column = if table == "sessions" {
                "id"
            } else {
                "session_id"
            };
            let owned: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE {id_column}='s-owned'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let other: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE {id_column}='s-other'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(owned, 0, "{table} retained workspace data");
            assert_eq!(other, 1, "{table} purged another workspace");
        }
        drop(repo);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    fn workspace(id: &str) -> WorkspaceDocument {
        WorkspaceDocument {
            id: id.into(),
            revision: 0,
            name: "Work".into(),
            icon: None,
            tabs: vec![TabDocument {
                id: format!("tab-{id}"),
                name: "shell".into(),
                custom_name: None,
                icon: None,
                cwd: "/tmp".into(),
                root: PaneTree::Leaf {
                    id: format!("pane-{id}"),
                    cwd: "/tmp".into(),
                    session_id: None,
                    agent: None,
                    runtime_status: None,
                    runtime_title: None,
                },
                file: None,
            }],
        }
    }

    #[test]
    fn import_lists_and_revision_conflict_is_explicit() {
        let path = temp_db();
        let repo = AgentRepository::open(&path).unwrap();
        let imported = repo.import_workspaces(vec![workspace("w")]).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].revision, 1);
        let unchanged = repo
            .apply_workspace_operation(
                "w",
                1,
                WorkspaceOperation::RenameWorkspace {
                    name: "Work".into(),
                },
            )
            .unwrap();
        assert_eq!(unchanged.revision, 1);
        let changed = repo
            .apply_workspace_operation(
                "w",
                1,
                WorkspaceOperation::RenameWorkspace { name: "New".into() },
            )
            .unwrap();
        assert_eq!(changed.revision, 2);
        assert!(matches!(
            repo.apply_workspace_operation(
                "w",
                1,
                WorkspaceOperation::RenameWorkspace {
                    name: "Stale".into()
                },
            ),
            Err(WorkspaceRepoError::RevisionConflict {
                expected: 1,
                actual: 2
            })
        ));
        drop(repo);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
