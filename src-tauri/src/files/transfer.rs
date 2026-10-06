//! 支持取消、进度事件、磁盘空间检查和临时文件原子落盘的长时间文件传输服务。

use reqwest::blocking::Response;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Webview};

use crate::path_policy::{authorize_path, ensure_trusted_caller, PathAccess};

const BUFFER_SIZE: usize = 1024 * 1024;
const MIN_FREE_SPACE_RESERVE: u64 = 64 * 1024 * 1024;
const PROGRESS_EVENT: &str = "file-transfer-progress";

static CANCELLED_TRANSFERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_transfers() -> &'static Mutex<HashSet<String>> {
    CANCELLED_TRANSFERS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTransferProgress {
    task_id: String,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferResult {
    pub(crate) path: String,
    pub(crate) total_bytes: u64,
    pub(crate) content_type: Option<String>,
}

pub(crate) struct DownloadMetadata {
    pub(crate) content_length: Option<u64>,
    pub(crate) content_type: Option<String>,
}

fn is_cancelled(task_id: &str) -> Result<bool, String> {
    cancelled_transfers()
        .lock()
        .map(|items| items.contains(task_id))
        .map_err(|_| "读取文件传输取消状态失败".to_string())
}

fn clear_cancelled(task_id: &str) {
    if let Ok(mut items) = cancelled_transfers().lock() {
        items.remove(task_id);
    }
}

fn required_free_space(total_bytes: u64) -> u64 {
    total_bytes.saturating_add((total_bytes / 20).max(MIN_FREE_SPACE_RESERVE))
}

fn ensure_disk_space(parent: &Path, total_bytes: Option<u64>) -> Result<(), String> {
    let available =
        fs2::available_space(parent).map_err(|e| format!("无法读取目标磁盘可用空间: {e}"))?;
    let required = total_bytes
        .map(required_free_space)
        .unwrap_or(MIN_FREE_SPACE_RESERVE);
    if available < required {
        return Err(format!(
            "目标磁盘空间不足，需要至少 {required} 字节，当前可用 {available} 字节"
        ));
    }
    Ok(())
}

fn temporary_path(destination: &Path, task_id: &str) -> Result<PathBuf, String> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "目标文件名无效".to_string())?;
    Ok(destination.with_file_name(format!(".{file_name}.{task_id}.part")))
}

fn validate_transfer_size(
    transferred_bytes: u64,
    expected_bytes: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    if let Some(max_bytes) = max_bytes {
        if transferred_bytes > max_bytes {
            return Err(format!("下载文件超过允许的体积上限 {max_bytes} 字节"));
        }
    }
    if let Some(expected_bytes) = expected_bytes {
        if transferred_bytes != expected_bytes {
            return Err(format!(
                "下载不完整: 期望 {expected_bytes} 字节，实际 {transferred_bytes} 字节"
            ));
        }
    }
    Ok(())
}

fn stream_to_file<R, C, P, V>(
    task_id: &str,
    reader: &mut R,
    destination: &Path,
    expected_bytes: Option<u64>,
    disk_space_bytes: Option<u64>,
    max_bytes: Option<u64>,
    mut cancelled: C,
    mut on_progress: P,
    validate_temp: V,
) -> Result<u64, String>
where
    R: Read,
    C: FnMut() -> Result<bool, String>,
    P: FnMut(u64),
    V: FnOnce(&Path) -> Result<(), String>,
{
    let parent = destination
        .parent()
        .ok_or_else(|| "目标文件没有父目录".to_string())?;
    ensure_disk_space(parent, disk_space_bytes)?;

    let temp_path = temporary_path(destination, task_id)?;
    let transfer_result = (|| {
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        let mut output = File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut buffer = vec![0_u8; BUFFER_SIZE];
        let mut transferred_bytes = 0_u64;

        loop {
            if cancelled()? {
                return Err("文件传输已取消".to_string());
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|e| format!("读取传输数据失败: {e}"))?;
            if read == 0 {
                break;
            }
            let next_total = transferred_bytes.saturating_add(read as u64);
            validate_transfer_size(next_total, None, max_bytes)?;
            output
                .write_all(&buffer[..read])
                .map_err(|e| format!("写入目标文件失败: {e}"))?;
            transferred_bytes = next_total;
            on_progress(transferred_bytes);
        }

        validate_transfer_size(transferred_bytes, expected_bytes, max_bytes)?;
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        output
            .sync_all()
            .map_err(|e| format!("同步目标文件失败: {e}"))?;
        drop(output);
        validate_temp(&temp_path)?;
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        // Never replace another generation/grouping result that won this destination.
        // Hard-link publication is atomic; filesystems without links use exclusive creation.
        match fs::hard_link(&temp_path, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err("目标文件已存在，已拒绝覆盖".to_string());
            }
            Err(_) => {
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(destination)
                    .map_err(|e| format!("创建目标文件失败（禁止覆盖）: {e}"))?;
                let write_result = (|| {
                    let mut source = File::open(&temp_path)?;
                    std::io::copy(&mut source, &mut target)?;
                    target.sync_all()
                })();
                drop(target);
                if let Err(error) = write_result {
                    let _ = fs::remove_file(destination);
                    return Err(format!("完成目标文件写入失败: {error}"));
                }
            }
        }
        let _ = fs::remove_file(&temp_path);
        Ok(transferred_bytes)
    })();

    if transfer_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    transfer_result
}

pub(crate) fn download_to_file<V>(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    destination: &Path,
    max_bytes: Option<u64>,
    validate_temp: V,
) -> Result<FileTransferResult, String>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
{
    let result = (|| {
        if is_cancelled(task_id)? {
            return Err("文件传输已取消".to_string());
        }
        let client = reqwest::blocking::Client::builder()
            .user_agent("AI-Canvas/0.4")
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
        let mut response: Response = client
            .get(url)
            .send()
            .map_err(|e| format!("下载请求失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("下载请求失败: HTTP {}", response.status()));
        }

        let metadata = DownloadMetadata {
            content_length: response.content_length(),
            content_type: response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(str::trim)
                .map(str::to_string),
        };
        if let (Some(content_length), Some(max_bytes)) = (metadata.content_length, max_bytes) {
            validate_transfer_size(content_length, None, Some(max_bytes))?;
        }

        let disk_space_bytes = metadata.content_length.or(max_bytes);
        let transferred = stream_to_file(
            task_id,
            &mut response,
            destination,
            metadata.content_length,
            disk_space_bytes,
            max_bytes,
            || is_cancelled(task_id),
            |transferred_bytes| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: task_id.to_string(),
                        transferred_bytes,
                        total_bytes: metadata.content_length,
                    },
                );
            },
            |temp_path| validate_temp(temp_path, &metadata),
        )?;

        Ok(FileTransferResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: transferred,
            content_type: metadata.content_type,
        })
    })();
    clear_cancelled(task_id);
    result
}

#[tauri::command]
pub async fn copy_file_streamed(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    source_path: String,
    destination_path: String,
) -> Result<FileTransferResult, String> {
    ensure_trusted_caller(&webview)?;
    // 源文件必须是用户显式给过的（对话框选中、拖入、已登记的素材目录），
    // 否则本命令等于把任意文件搬进项目目录，再经 asset 协议读走。
    let source = authorize_path(&app, &source_path, PathAccess::Read)?;
    let destination = authorize_path(&app, &destination_path, PathAccess::Write)?;

    let task_id_for_worker = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let total_bytes = fs::metadata(&source)
            .map_err(|e| format!("读取源文件信息失败: {e}"))?
            .len();
        let mut input = File::open(&source).map_err(|e| format!("打开源文件失败: {e}"))?;
        let transferred = stream_to_file(
            &task_id_for_worker,
            &mut input,
            &destination,
            Some(total_bytes),
            Some(total_bytes),
            None,
            || is_cancelled(&task_id_for_worker),
            |transferred_bytes| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: task_id_for_worker.clone(),
                        transferred_bytes,
                        total_bytes: Some(total_bytes),
                    },
                );
            },
            |_| Ok(()),
        )?;
        Ok(FileTransferResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: transferred,
            content_type: None,
        })
    })
    .await
    .map_err(|e| format!("文件复制任务执行失败: {e}"))?;
    clear_cancelled(&task_id);
    result
}

#[tauri::command]
pub async fn download_file_streamed(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    url: String,
    destination_path: String,
) -> Result<FileTransferResult, String> {
    ensure_trusted_caller(&webview)?;
    let destination = authorize_path(&app, &destination_path, PathAccess::Write)?;

    let task_id_for_worker = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_to_file(
            &app,
            &task_id_for_worker,
            &url,
            &destination,
            None,
            |_, _| Ok(()),
        )
    })
    .await
    .map_err(|e| format!("文件下载任务执行失败: {e}"))?;
    result
}

fn plain_copy_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "复制源不可访问")?;
    #[cfg(target_os = "windows")]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(target_os = "windows"))]
    let reparse = false;
    if reparse || metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        return Err("文件夹包含链接或特殊文件，已停止复制".into());
    }
    Ok(metadata)
}

struct FolderCopyPlan {
    directories: Vec<PathBuf>,
    files: Vec<(PathBuf, u64)>,
    bytes: u64,
}

fn plan_folder_copy<C, V>(
    source: &Path,
    mut cancelled: C,
    mut validate: V,
) -> Result<FolderCopyPlan, String>
where
    C: FnMut() -> Result<bool, String>,
    V: FnMut(&Path, bool) -> Result<(), String>,
{
    if !plain_copy_metadata(source)?.is_dir() {
        return Err("复制源必须是文件夹".into());
    }
    let mut plan = FolderCopyPlan {
        directories: vec![PathBuf::new()],
        files: Vec::new(),
        bytes: 0,
    };
    let mut stack = vec![(PathBuf::new(), 0_usize)];
    while let Some((relative, depth)) = stack.pop() {
        if cancelled()? {
            return Err("文件夹复制已取消".into());
        }
        let directory = source.join(&relative);
        validate(&directory, true)?;
        for entry in fs::read_dir(&directory).map_err(|_| "无法读取复制源目录")? {
            if cancelled()? {
                return Err("文件夹复制已取消".into());
            }
            let entry = entry.map_err(|_| "无法读取复制源条目")?;
            let child = relative.join(entry.file_name());
            let metadata = plain_copy_metadata(&source.join(&child))?;
            validate(&source.join(&child), metadata.is_dir())?;
            if plan.files.len() + plan.directories.len() >= 100_000 || depth >= 128 {
                return Err("目录条目或深度超过复制上限，未开始写入".into());
            }
            if metadata.is_dir() {
                plan.directories.push(child.clone());
                stack.push((child, depth + 1));
            } else {
                plan.bytes = plan
                    .bytes
                    .checked_add(metadata.len())
                    .ok_or("目录体积超过上限")?;
                plan.files.push((child, metadata.len()));
            }
        }
    }
    plan.directories
        .sort_by_key(|path| path.components().count());
    Ok(plan)
}

fn folder_copy_destination(source: &Path, parent: &Path) -> Result<PathBuf, String> {
    if parent.starts_with(source) {
        return Err("不能将文件夹粘贴到自身或其子目录".into());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无法复制磁盘根目录")?;
    for index in 0..10_000 {
        let candidate = parent.join(if index == 0 {
            name.to_string()
        } else {
            format!("{name} - 副本 ({index})")
        });
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("创建粘贴目标失败".into()),
        }
    }
    Err("同名文件夹过多，请更换目标目录".into())
}

#[tauri::command]
pub async fn copy_asset_folder(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    source_path: String,
    destination_directory: String,
) -> Result<FileTransferResult, String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("文件夹粘贴仅允许主窗口调用".into());
    }
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("传输标识无效".into());
    }
    let source = crate::path_policy::authorize_existing_plain_directory(&app, &source_path)?;
    let parent =
        crate::path_policy::authorize_existing_plain_directory(&app, &destination_directory)?;
    if parent.starts_with(&source) {
        return Err("不能将文件夹粘贴到自身或其子目录".into());
    }
    let worker_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let validate_source = |path: &Path, directory: bool| -> Result<(), String> {
            let raw = path.to_string_lossy();
            let authorized = if directory {
                crate::path_policy::authorize_existing_plain_directory(&app, &raw)?
            } else {
                crate::path_policy::authorize_existing_plain_file(&app, &raw)?
            };
            if !authorized.starts_with(&source) {
                return Err("复制源已变化，已停止复制".into());
            }
            Ok(())
        };
        let plan = plan_folder_copy(&source, || is_cancelled(&worker_id), validate_source)?;
        ensure_disk_space(&parent, Some(plan.bytes))?;
        crate::path_policy::reauthorize_existing_plain_directory(&app, &parent)?;
        if is_cancelled(&worker_id)? {
            return Err("文件夹复制已取消".into());
        }
        let destination = folder_copy_destination(&source, &parent)?;
        // 取消/失败保留已经完成的副本；从不删除原目录或覆盖既有目标。
        let copy_result = (|| {
            let mut completed_bytes = 0;
            for relative in plan.directories.iter().skip(1) {
                if is_cancelled(&worker_id)? {
                    return Err("文件夹复制已取消".to_string());
                }
                let target = destination.join(relative);
                let authorized =
                    authorize_path(&app, &target.to_string_lossy(), PathAccess::Write)?;
                if !authorized.starts_with(&destination) {
                    return Err("粘贴目标已变化".into());
                }
                fs::create_dir(&target).map_err(|_| "创建子文件夹失败")?;
            }
            for (relative, expected) in &plan.files {
                if is_cancelled(&worker_id)? {
                    return Err("文件夹复制已取消".into());
                }
                let path = source.join(relative);
                validate_source(&path, false)?;
                if plain_copy_metadata(&path)?.len() != *expected {
                    return Err("复制源文件已变化".into());
                }
                let target = destination.join(relative);
                let authorized =
                    authorize_path(&app, &target.to_string_lossy(), PathAccess::Write)?;
                if !authorized.starts_with(&destination) {
                    return Err("粘贴目标已变化".into());
                }
                let mut input = File::open(path).map_err(|_| "无法打开复制源文件")?;
                stream_to_file(
                    &worker_id,
                    &mut input,
                    &target,
                    Some(*expected),
                    Some(*expected),
                    None,
                    || is_cancelled(&worker_id),
                    |current| {
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            FileTransferProgress {
                                task_id: worker_id.clone(),
                                transferred_bytes: completed_bytes + current,
                                total_bytes: Some(plan.bytes),
                            },
                        );
                    },
                    |_| Ok(()),
                )?;
                completed_bytes += expected;
            }
            let _ = app.emit(
                PROGRESS_EVENT,
                FileTransferProgress {
                    task_id: worker_id.clone(),
                    transferred_bytes: plan.bytes,
                    total_bytes: Some(plan.bytes),
                },
            );
            Ok(FileTransferResult {
                path: destination.to_string_lossy().into_owned(),
                total_bytes: plan.bytes,
                content_type: None,
            })
        })();
        copy_result.map_err(|error: String| format!("{error}；已复制内容保留在目标目录"))
    })
    .await
    .map_err(|_| "文件夹复制任务失败".to_string());
    clear_cancelled(&task_id);
    result?
}

#[tauri::command]
pub fn cancel_file_transfer(task_id: String) -> Result<(), String> {
    cancelled_transfers()
        .lock()
        .map_err(|_| "更新文件传输取消状态失败".to_string())?
        .insert(task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn folder_plan_preserves_nested_and_empty_directories() {
        let root = test_directory("folder-plan");
        fs::create_dir_all(root.join("人物/空目录")).unwrap();
        fs::write(root.join("人物/image.png"), b"data").unwrap();
        let plan = plan_folder_copy(&root, || Ok(false), |_, _| Ok(())).unwrap();
        assert_eq!(plan.bytes, 4);
        assert_eq!(plan.directories.len(), 3);
        assert_eq!(plan.files[0].0, PathBuf::from("人物/image.png"));
        assert!(plan_folder_copy(&root, || Ok(true), |_, _| Ok(())).is_err());
        assert!(folder_copy_destination(&root, &root.join("人物")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_destination_uses_exclusive_creation_and_keeps_existing_content() {
        let parent = test_directory("folder-conflict");
        let source = parent.join("素材");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("original"), b"original").unwrap();
        let destination = folder_copy_destination(&source, &parent).unwrap();
        assert_ne!(destination, source);
        assert!(destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("副本"));
        assert_eq!(fs::read(source.join("original")).unwrap(), b"original");
        fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn folder_plan_rejects_symlinks_before_copying() {
        let root = test_directory("folder-link");
        std::os::unix::fs::symlink(&root, root.join("cycle")).unwrap();
        assert!(plan_folder_copy(&root, || Ok(false), |_, _| Ok(())).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    struct GeneratedReader {
        remaining: u64,
    }

    impl Read for GeneratedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.remaining.min(buffer.len() as u64) as usize;
            buffer[..read].fill(0x5a);
            self.remaining -= read as u64;
            Ok(read)
        }
    }

    fn test_directory(name: &str) -> PathBuf {
        let unique = format!(
            "ai-canvas-file-transfer-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时间应晚于 UNIX epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        fs::create_dir_all(&directory).expect("应创建测试目录");
        directory
    }

    fn part_path(destination: &Path, task_id: &str) -> PathBuf {
        temporary_path(destination, task_id).expect("应生成临时路径")
    }

    #[test]
    fn reserves_at_least_sixty_four_megabytes() {
        assert_eq!(required_free_space(100), 100 + MIN_FREE_SPACE_RESERVE);
    }

    #[test]
    fn never_overwrites_a_destination_created_during_transfer() {
        let directory = test_directory("no-clobber");
        let destination = directory.join("result.png");
        let mut reader = Cursor::new(b"new result".to_vec());
        let result = stream_to_file(
            "race",
            &mut reader,
            &destination,
            None,
            None,
            None,
            || Ok(false),
            |_| {},
            |_| {
                fs::write(&destination, b"existing result").unwrap();
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing result");
        assert!(!part_path(&destination, "race").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reserves_five_percent_for_large_files() {
        let size = 2 * 1024 * 1024 * 1024_u64;
        assert_eq!(required_free_space(size), size + size / 20);
    }

    #[test]
    fn streams_then_atomically_promotes_complete_file() {
        let directory = test_directory("complete");
        let destination = directory.join("model.onnx");
        let task_id = "complete-task";
        let bytes = vec![7_u8; BUFFER_SIZE + 17];
        let mut reader = Cursor::new(bytes.clone());

        let transferred = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            Some(bytes.len() as u64),
            Some(bytes.len() as u64),
            Some((bytes.len() + 1) as u64),
            || Ok(false),
            |_| {},
            |_| Ok(()),
        )
        .expect("完整传输应成功");

        assert_eq!(transferred, bytes.len() as u64);
        assert_eq!(fs::read(&destination).expect("应读取正式文件"), bytes);
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn removes_part_when_actual_length_differs() {
        let directory = test_directory("length-mismatch");
        let destination = directory.join("model.onnx");
        let task_id = "length-task";
        let mut reader = Cursor::new(vec![1_u8; 32]);

        let result = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            Some(64),
            Some(64),
            None,
            || Ok(false),
            |_| {},
            |_| Ok(()),
        );

        assert!(result.expect_err("长度不符应失败").contains("下载不完整"));
        assert!(!destination.exists());
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn removes_part_when_transfer_exceeds_limit() {
        let directory = test_directory("too-large");
        let destination = directory.join("model.onnx");
        let task_id = "limit-task";
        let mut reader = Cursor::new(vec![2_u8; 65]);

        let result = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            None,
            Some(64),
            Some(64),
            || Ok(false),
            |_| {},
            |_| Ok(()),
        );

        assert!(result.expect_err("超过上限应失败").contains("体积上限"));
        assert!(!destination.exists());
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn removes_part_when_cancelled_mid_transfer() {
        let directory = test_directory("cancelled");
        let destination = directory.join("model.onnx");
        let task_id = "cancel-task";
        let mut reader = Cursor::new(vec![3_u8; BUFFER_SIZE * 2]);
        let mut checks = 0_u8;

        let result = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            None,
            Some((BUFFER_SIZE * 2) as u64),
            None,
            || {
                checks += 1;
                Ok(checks >= 3)
            },
            |_| {},
            |_| Ok(()),
        );

        assert!(result.expect_err("取消应失败").contains("已取消"));
        assert!(!destination.exists());
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    #[ignore = "176 MiB 磁盘与内存压力验收"]
    fn streams_176_mib_without_allocating_the_model_in_memory() {
        let directory = test_directory("176-mib");
        let destination = directory.join("model.onnx");
        let task_id = "memory-task";
        let total_bytes = 176 * 1024 * 1024_u64;
        let mut reader = GeneratedReader {
            remaining: total_bytes,
        };

        let transferred = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            Some(total_bytes),
            Some(total_bytes),
            Some(total_bytes),
            || Ok(false),
            |_| {},
            |_| Ok(()),
        )
        .expect("176 MiB 流式传输应成功");

        assert_eq!(transferred, total_bytes);
        assert_eq!(
            fs::metadata(&destination).expect("应读取正式文件").len(),
            total_bytes
        );
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }
}
