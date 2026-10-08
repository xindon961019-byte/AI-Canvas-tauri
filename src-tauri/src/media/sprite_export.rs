//! Sprite Sheet 原生处理与编排导出：GIF、PNG 序列帧、PNG 图集 + JSON。

#[cfg(test)]
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use image::codecs::gif::{GifEncoder, Repeat};
use image::{Delay, Frame, RgbaImage};
use serde_json::json;

use crate::path_policy::{authorize_path, PathAccess};
use crate::sprite_processing::{self, FrameEdit, SpriteOptions};

const MAX_FRAMES: u32 = 256;

/// 按 cols×rows 等分切出前 frame_count 帧，顺序与生成时一致：从左到右、从上到下。
#[cfg(test)]
fn slice_frames(
    sheet: &RgbaImage,
    cols: u32,
    rows: u32,
    frame_count: u32,
) -> Result<Vec<RgbaImage>, String> {
    Ok(
        sprite_processing::prepare(sheet.clone(), &SpriteOptions::grid(cols, rows, frame_count))?
            .frames,
    )
}

// ponytail: GIF 只有 1 位透明和 256 色，用来预览和分享够了；要保真就导 PNG 序列帧。
fn gif_bytes(frames: &[RgbaImage], fps: u32, looping: bool) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = GifEncoder::new(&mut bytes);
    if looping {
        encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|_| "设置 GIF 循环失败")?;
    }

    let delay = Delay::from_numer_denom_ms(1000, fps);
    for (index, frame) in frames.iter().enumerate() {
        encoder
            .encode_frame(Frame::from_parts(frame.clone(), 0, 0, delay))
            .map_err(|error| format!("写入第 {} 帧失败: {error}", index + 1))?;
    }
    drop(encoder);
    Ok(bytes)
}

/// 每个派生路径独立授权。只创建新文件，任何冲突或写入失败都清理本轮新文件。
fn publish_outputs(
    app: &tauri::AppHandle,
    outputs: Vec<(PathBuf, Vec<u8>)>,
) -> Result<Vec<String>, String> {
    let mut authorized = Vec::new();
    for (path, bytes) in outputs {
        let path = authorize_path(
            app,
            path.to_str().ok_or("导出路径编码无效")?,
            PathAccess::Write,
        )?;
        if path.exists() {
            return Err("导出文件已存在，请选择新的名称，避免覆盖已有图集或序列帧".into());
        }
        authorized.push((path, bytes));
    }
    write_new_outputs(authorized)
}

fn write_new_outputs(outputs: Vec<(PathBuf, Vec<u8>)>) -> Result<Vec<String>, String> {
    let mut created = Vec::new();
    for (path, bytes) in outputs {
        let result = (|| {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| "无法创建导出文件，请检查名称和权限")?;
            created.push(path.clone());
            let mut writer = BufWriter::new(file);
            writer.write_all(&bytes).map_err(|_| "导出文件写入失败")?;
            writer.flush().map_err(|_| "导出文件写入未完成")
        })();
        if let Err(error) = result {
            for created_path in &created {
                let _ = std::fs::remove_file(created_path);
            }
            return Err(error.into());
        }
    }
    Ok(created
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

fn encode_outputs(
    frames: &[RgbaImage],
    output: &Path,
    cols: u32,
    fps: u32,
    looping: bool,
    action: Option<&str>,
    warnings: &[String],
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    if frames.is_empty() || cols == 0 || fps == 0 {
        return Err("导出帧或参数无效".into());
    }
    let frame_width = frames[0].width();
    let frame_height = frames[0].height();
    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let parent = output.parent().ok_or("无法解析导出目录")?;
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or("导出名称无效")?;
    let outputs = match extension.as_str() {
        "gif" => vec![(output.to_path_buf(), gif_bytes(frames, fps, looping)?)],
        "png" => frames
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                Ok((
                    parent.join(format!("{stem}_{index:03}.png")),
                    sprite_processing::png_bytes(frame.clone())?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?,
        "json" => {
            let image = sprite_processing::atlas(frames, cols)?;
            let columns = cols.min(frames.len() as u32);
            let rects: Vec<_> = (0..frames.len() as u32).map(|i| json!({"x": i % columns * frame_width, "y": i / columns * frame_height, "w": frame_width, "h": frame_height})).collect();
            let state = action
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 64
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                })
                .unwrap_or("animation");
            let manifest = json!({
                "version": 1, "image": format!("{stem}.png"),
                "frame_layout": {"sheetWidth": image.width(), "sheetHeight": image.height(), "cellWidth": frame_width, "cellHeight": frame_height, "rows": {state: rects}},
                "animation": {"rows": {state: {"frames": frames.len(), "fps": fps, "loop": looping, "durations_ms": vec![1000.0 / f64::from(fps); frames.len()]}}},
                "warnings": warnings,
            });
            vec![
                (
                    parent.join(format!("{stem}.png")),
                    sprite_processing::png_bytes(image)?,
                ),
                (
                    output.to_path_buf(),
                    serde_json::to_vec_pretty(&manifest).map_err(|_| "图集元数据编码失败")?,
                ),
            ]
        }
        _ => return Err("导出格式无效".into()),
    };
    Ok(outputs)
}

/// `.gif` 动图、`.png` 序列帧、`.json` 图集 + manifest。原图始终只读。
#[tauri::command]
pub async fn export_sprite_frames(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input_path: String,
    output_path: String,
    cols: u32,
    rows: u32,
    frame_count: u32,
    fps: u32,
    options: Option<SpriteOptions>,
    edits: Option<Vec<FrameEdit>>,
    looping: Option<bool>,
    action: Option<String>,
) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let input = authorize_path(&app, &input_path, PathAccess::Read)?;
    if !input.is_file() {
        return Err("Sprite Sheet 不存在".into());
    }
    let output = authorize_path(&app, &output_path, PathAccess::Write)?;

    if !(1..=60).contains(&fps) {
        return Err(format!("帧率 {fps} 超出 1–60 范围"));
    }
    if frame_count > MAX_FRAMES {
        return Err(format!("帧数 {frame_count} 超出上限 {MAX_FRAMES}"));
    }

    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if !matches!(extension.as_str(), "gif" | "png" | "json") {
        return Err("请选择 GIF、PNG 序列帧或 JSON 图集".into());
    }
    let options = options.unwrap_or_else(|| SpriteOptions::grid(cols, rows, frame_count));
    options.validate()?;
    let _slot = sprite_processing::processing_slot().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = sprite_processing::prepare(sprite_processing::read_sheet(&input)?, &options)?;
        let frames = sprite_processing::curate(&prepared.frames, edits.as_deref())?;
        let frame_width = frames[0].width(); let frame_height = frames[0].height();
        let outputs = encode_outputs(&frames, &output, options.cols, fps, looping.unwrap_or(true), action.as_deref(), &prepared.warnings)?;
        if outputs.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() > 128 * 1024 * 1024 { return Err("导出产物超过 128 MiB 限制".into()); }
        let files = publish_outputs(&app, outputs)?;
        Ok(json!({ "files": files, "frame_width": frame_width, "frame_height": frame_height, "format": extension, "frame_count": frames.len() }).to_string())
    }).await.map_err(|_| "动画导出任务异常退出".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张 4×2 宫格，每格 3×5 像素，格内填该格序号作为红通道。
    fn numbered_sheet() -> RgbaImage {
        RgbaImage::from_fn(12, 10, |x, y| {
            let index = (y / 5) * 4 + (x / 3);
            image::Rgba([index as u8, 0, 0, 255])
        })
    }

    #[test]
    fn slices_cells_in_row_major_order() {
        let frames = slice_frames(&numbered_sheet(), 4, 2, 8).expect("应切出 8 帧");
        assert_eq!(frames.len(), 8);
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.dimensions(), (3, 5));
            assert_eq!(
                frame.get_pixel(0, 0)[0],
                index as u8,
                "第 {index} 帧位置不对"
            );
        }
    }

    #[test]
    fn slices_only_the_requested_leading_frames() {
        let frames = slice_frames(&numbered_sheet(), 4, 2, 6).expect("应切出 6 帧");
        assert_eq!(frames.len(), 6);
        assert_eq!(frames[5].get_pixel(0, 0)[0], 5);
    }

    #[test]
    fn writes_a_readable_gif_and_a_png_per_frame() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-sprite-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时间应晚于 UNIX epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("应创建测试目录");
        let frames = slice_frames(&numbered_sheet(), 4, 2, 8).expect("应切出 8 帧");

        let gif_path = directory.join("walk.gif");
        write_new_outputs(
            encode_outputs(&frames, &gif_path, 4, 12, true, Some("walk"), &[]).unwrap(),
        )
        .expect("应写出 GIF");
        // 编码器必须已 flush 并写完尾块，否则这里解不出 8 帧
        let decoded = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(
            File::open(&gif_path).expect("应打开 GIF"),
        ))
        .expect("应解码 GIF");
        assert_eq!(image::AnimationDecoder::into_frames(decoded).count(), 8);

        let png_path = directory.join("walk.png");
        let files = write_new_outputs(
            encode_outputs(&frames, &png_path, 4, 12, true, Some("walk"), &[]).unwrap(),
        )
        .expect("应写出序列帧");
        assert_eq!(files.len(), 8);
        assert!(directory.join("walk_000.png").is_file());
        assert!(directory.join("walk_007.png").is_file());

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn rejects_invalid_grids() {
        let sheet = numbered_sheet();
        assert!(slice_frames(&sheet, 4, 2, 9).is_err(), "帧数超容量应报错");
        assert!(slice_frames(&sheet, 4, 2, 0).is_err(), "0 帧应报错");
        assert!(slice_frames(&sheet, 0, 2, 4).is_err(), "0 列应报错");
        assert!(
            slice_frames(&sheet, 40, 2, 4).is_err(),
            "格子小于 1px 应报错"
        );
    }

    #[test]
    fn single_play_gif_omits_loop_extension() {
        let frames = slice_frames(&numbered_sheet(), 4, 2, 8).unwrap();
        let once = gif_bytes(&frames, 8, false).unwrap();
        let looping = gif_bytes(&frames, 8, true).unwrap();
        assert!(!once.windows(11).any(|w| w == b"NETSCAPE2.0"));
        assert!(looping.windows(11).any(|w| w == b"NETSCAPE2.0"));
    }

    #[test]
    fn atlas_manifest_matches_curated_pixels_and_timing() {
        let source = slice_frames(&numbered_sheet(), 4, 2, 8).unwrap();
        let edits: Vec<_> = (0..8)
            .rev()
            .map(|source_index| FrameEdit {
                source_index,
                enabled: source_index > 4,
                offset_x: 0,
                offset_y: 0,
            })
            .collect();
        let frames = sprite_processing::curate(&source, Some(&edits)).unwrap();
        let outputs = encode_outputs(
            &frames,
            Path::new("exports/walk.json"),
            2,
            8,
            false,
            Some("walk"),
            &[],
        )
        .unwrap();
        let atlas = image::load_from_memory(&outputs[0].1).unwrap().to_rgba8();
        assert_eq!(atlas.dimensions(), (6, 10));
        assert_eq!(atlas.get_pixel(0, 0)[0], 7);
        assert_eq!(atlas.get_pixel(3, 0)[0], 6);
        assert_eq!(atlas.get_pixel(0, 5)[0], 5);
        let manifest: serde_json::Value = serde_json::from_slice(&outputs[1].1).unwrap();
        assert_eq!(
            manifest["frame_layout"]["rows"]["walk"][2],
            json!({"x": 0, "y": 5, "w": 3, "h": 5})
        );
        assert_eq!(
            manifest["animation"]["rows"]["walk"]["durations_ms"],
            json!([125.0, 125.0, 125.0])
        );
        assert_eq!(manifest["animation"]["rows"]["walk"]["loop"], false);
    }

    #[test]
    fn collision_preserves_existing_file_and_rolls_back_only_new_files() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-sprite-collision-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let first = directory.join("new.png");
        let existing = directory.join("existing.png");
        std::fs::write(&existing, b"original").unwrap();
        assert!(write_new_outputs(vec![
            (first.clone(), b"new".to_vec()),
            (existing.clone(), b"replacement".to_vec())
        ])
        .is_err());
        assert!(!first.exists());
        assert_eq!(std::fs::read(&existing).unwrap(), b"original");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
