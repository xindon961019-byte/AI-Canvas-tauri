//! Deterministic sprite processing, inspired by sprite-gen (Apache-2.0).
//! Alpha/foot centroid alignment derives from perfectpixel-studio (MIT).
//! See public/licenses/sprite-gen-NOTICE.txt. No Python runtime is used.
use std::collections::VecDeque;
use std::io::{BufReader, Cursor};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageReader, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

const MAX_PIXELS: u64 = 16_777_216;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
static PROCESSING_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ChromaKey {
    Auto,
    Magenta,
    Green,
    None,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Alignment {
    Foot,
    Alpha,
    None,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Segmentation {
    Grid,
    Projection,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpriteOptions {
    pub cols: u32,
    pub rows: u32,
    pub frame_count: u32,
    pub chroma_key: ChromaKey,
    pub key_threshold: f64,
    pub segmentation: Segmentation,
    pub alignment: Alignment,
    pub ground: bool,
    pub margin: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameEdit {
    pub source_index: usize,
    pub enabled: bool,
    pub offset_x: i32,
    pub offset_y: i32,
}

#[derive(Clone, Copy, Serialize, Debug)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameAnalysis {
    source_index: usize,
    source_rect: Rect,
    content_bounds: Rect,
    anchor_x: f64,
    offset_x: i64,
    offset_y: i64,
}
pub struct PreparedSprite {
    pub frames: Vec<RgbaImage>,
    pub analyses: Vec<FrameAnalysis>,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpritePreview {
    png_base64: String,
    width: u32,
    height: u32,
    cell_width: u32,
    cell_height: u32,
    cols: u32,
    rows: u32,
    frames: Vec<FrameAnalysis>,
    warnings: Vec<String>,
}

impl SpriteOptions {
    pub fn grid(cols: u32, rows: u32, frame_count: u32) -> Self {
        Self {
            cols,
            rows,
            frame_count,
            chroma_key: ChromaKey::None,
            key_threshold: 55.0,
            segmentation: Segmentation::Grid,
            alignment: Alignment::None,
            ground: false,
            margin: 0.0,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.cols == 0
            || self.rows == 0
            || self.cols > 256
            || self.rows > 256
            || self.frame_count == 0
            || self.frame_count > 256
            || self.frame_count > self.cols.checked_mul(self.rows).unwrap_or(0)
        {
            return Err("宫格或帧数无效（最多 256 帧）".into());
        }
        if !self.key_threshold.is_finite()
            || !(1.0..=160.0).contains(&self.key_threshold)
            || !self.margin.is_finite()
            || !(0.0..=0.2).contains(&self.margin)
        {
            return Err("底色容差或安全边距无效".into());
        }
        Ok(())
    }
}

pub async fn processing_slot() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    PROCESSING_SLOTS
        .acquire()
        .await
        .map_err(|_| "动画处理队列已关闭".into())
}

pub fn read_sheet(path: &Path) -> Result<RgbaImage, String> {
    let file = std::fs::File::open(path).map_err(|_| "无法打开动画原图")?;
    if file.metadata().map_err(|_| "无法读取动画原图信息")?.len() > MAX_FILE_BYTES {
        return Err("动画原图超过 64 MiB 限制".into());
    }
    let mut reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|_| "无法识别动画原图格式")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    reader.limits(limits);
    // 检查 header 后再解码，避免压缩图触发巨量像素分配。
    let dimensions = image::image_dimensions(path).map_err(|_| "无法读取动画原图尺寸")?;
    if u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_PIXELS {
        return Err("动画原图超过 1600 万像素限制".into());
    }
    reader
        .decode()
        .map(|value| value.to_rgba8())
        .map_err(|_| "动画原图解码失败".into())
}

fn key_tint(pixel: &[u8; 4], green: bool) -> f64 {
    if green {
        f64::from(pixel[1]) - (f64::from(pixel[0]) + f64::from(pixel[2])) / 2.0
    } else {
        (f64::from(pixel[0]) + f64::from(pixel[2])) / 2.0 - f64::from(pixel[1])
    }
}

fn detected_key(sheet: &RgbaImage, requested: ChromaKey) -> Option<([u8; 3], bool)> {
    if requested == ChromaKey::None {
        return None;
    }
    let (w, h) = sheet.dimensions();
    let mut green = Vec::new();
    let mut magenta = Vec::new();
    let mut samples = 0;
    // 用边界颜色的中位数识别实际绘制的底色，而不是只匹配理想纯色。
    for (x, y, p) in sheet.enumerate_pixels() {
        if x != 0 && y != 0 && x != w - 1 && y != h - 1 {
            continue;
        }
        if p[3] < 240 {
            continue;
        }
        samples += 1;
        if key_tint(&p.0, true) > 70.0 {
            green.push([p[0], p[1], p[2]]);
        }
        if key_tint(&p.0, false) > 70.0 && p[0].min(p[2]) > p[1] {
            magenta.push([p[0], p[1], p[2]]);
        }
    }
    let is_green = match requested {
        ChromaKey::Green => true,
        ChromaKey::Magenta => false,
        _ => green.len() > magenta.len(),
    };
    let values = if is_green { &mut green } else { &mut magenta };
    if requested == ChromaKey::Auto && (samples == 0 || values.len() * 2 < samples) {
        return None;
    }
    let mut key = if is_green { [0, 255, 0] } else { [255, 0, 255] };
    if !values.is_empty() {
        for channel in 0..3 {
            values.sort_unstable_by_key(|value| value[channel]);
            key[channel] = values[values.len() / 2][channel];
        }
    }
    Some((key, is_green))
}

fn remove_key(sheet: &mut RgbaImage, key: [u8; 3], green: bool, threshold: f64) {
    let (w, h) = sheet.dimensions();
    let ideal = if green { [0, 255, 0] } else { [255, 0, 255] };
    let distance = |p: &Rgba<u8>, colour: [u8; 3]| -> f64 {
        (0..3)
            .map(|c| (f64::from(p[c]) - f64::from(colour[c])).powi(2))
            .sum::<f64>()
            .sqrt()
    };
    let mut depths = vec![u8::MAX; (w * h) as usize];
    let mut frontier = VecDeque::new();
    for (index, pixel) in sheet.pixels_mut().enumerate() {
        if pixel[3] == 0 || distance(pixel, key).min(distance(pixel, ideal)) <= threshold {
            *pixel = Rgba([0, 0, 0, 0]);
            depths[index] = 0;
            frontier.push_back(index);
        }
    }
    // 有界的 8 邻域距离场：内孔同样能去色，只处理紧邻已确认底色的软边。
    while let Some(index) = frontier.pop_front() {
        let depth = depths[index];
        if depth >= 3 {
            continue;
        }
        let x = index as i64 % i64::from(w);
        let y = index as i64 / i64::from(w);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let nx = x + dx;
                let ny = y + dy;
                if nx < 0 || ny < 0 || nx >= i64::from(w) || ny >= i64::from(h) {
                    continue;
                }
                let next = (ny as u32 * w + nx as u32) as usize;
                if depths[next] == u8::MAX {
                    depths[next] = depth + 1;
                    frontier.push_back(next);
                }
            }
        }
    }
    let key_score = key_tint(&[key[0], key[1], key[2], 255], green).max(1.0);
    for (index, pixel) in sheet.pixels_mut().enumerate() {
        if depths[index] == 0 || depths[index] > 3 || pixel[3] == 0 {
            continue;
        }
        let tint = key_tint(&pixel.0, green);
        if tint <= 12.0 {
            continue;
        }
        let mixed = (tint / key_score).clamp(0.0, 1.0);
        let coverage = 1.0 - mixed;
        if coverage <= 0.01 {
            *pixel = Rgba([0, 0, 0, 0]);
            continue;
        }
        for c in 0..3 {
            pixel[c] = ((f64::from(pixel[c]) - mixed * f64::from(key[c])) / coverage)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
        pixel[3] = (f64::from(pixel[3]) * coverage).round() as u8;
    }
}

fn alpha_bounds(image: &RgbaImage) -> Option<Rect> {
    let (mut left, mut top, mut right, mut bottom) = (image.width(), image.height(), 0, 0);
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] <= 10 {
            continue;
        }
        left = left.min(x);
        top = top.min(y);
        right = right.max(x + 1);
        bottom = bottom.max(y + 1);
    }
    (right > left && bottom > top).then(|| Rect {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    })
}

fn centroid(image: &RgbaImage, bounds: Rect, foot: bool) -> f64 {
    let top = if foot {
        bounds.y + bounds.h.saturating_sub((bounds.h / 5).max(2))
    } else {
        bounds.y
    };
    let (mut weighted, mut total) = (0.0, 0.0);
    for y in top..bounds.y + bounds.h {
        for x in bounds.x..bounds.x + bounds.w {
            let alpha = image.get_pixel(x, y)[3];
            if alpha > 10 {
                total += f64::from(alpha);
                weighted += (f64::from(x) + 0.5) * f64::from(alpha);
            }
        }
    }
    if total > 0.0 {
        weighted / total
    } else {
        f64::from(bounds.x) + f64::from(bounds.w) / 2.0
    }
}

fn row_boundaries(
    sheet: &RgbaImage,
    options: &SpriteOptions,
    top: u32,
    bottom: u32,
) -> (Vec<u32>, bool) {
    let w = sheet.width();
    let mut cuts = vec![0];
    let mut touching = false;
    for col in 1..options.cols {
        let nominal = w * col / options.cols;
        let radius = (w / options.cols / 5).max(1);
        let start = nominal.saturating_sub(radius).max(cuts[cuts.len() - 1] + 1);
        let end = (nominal + radius).min(w - (options.cols - col));
        let mut best = (u64::MAX, nominal);
        if options.segmentation == Segmentation::Projection {
            for x in start..=end {
                let mass: u64 = (top..bottom)
                    .map(|y| u64::from(sheet.get_pixel(x, y)[3]))
                    .sum();
                // 首要选择低 Alpha 的沟槽，空白区内靠近原宫格线，避免累积偏移。
                let score = mass * u64::from(w + 1) + u64::from(x.abs_diff(nominal));
                if score < best.0 {
                    best = (score, x);
                }
            }
            touching |= (top..bottom).any(|y| sheet.get_pixel(best.1, y)[3] > 10);
            cuts.push(best.1);
        } else {
            cuts.push(nominal);
        }
    }
    cuts.push(w);
    (cuts, touching)
}

pub fn prepare(mut sheet: RgbaImage, options: &SpriteOptions) -> Result<PreparedSprite, String> {
    options.validate()?;
    let (w, h) = sheet.dimensions();
    if w < options.cols || h < options.rows || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("动画图片尺寸不适合指定宫格".into());
    }
    let mut warnings = Vec::new();
    let has_alpha = sheet.pixels().any(|p| p[3] == 0);
    if let Some((key, green)) = detected_key(&sheet, options.chroma_key) {
        remove_key(&mut sheet, key, green, options.key_threshold);
    } else if !has_alpha && options.chroma_key == ChromaKey::Auto {
        warnings.push("没有识别到绿幕或品红底色，已保留背景；请手动选择底色或使用透明原图".into());
    }
    let cw = w / options.cols;
    let ch = h / options.rows;
    let margin_x = (f64::from(cw) * options.margin).round();
    let margin_y = (f64::from(ch) * options.margin).round();
    let mut sources = Vec::new();
    let mut analyses = Vec::new();
    let mut scale: f64 = 1.0;
    for row in 0..options.rows {
        let top = h * row / options.rows;
        let bottom = h * (row + 1) / options.rows;
        let (cuts, touching) = row_boundaries(&sheet, options, top, bottom);
        if touching {
            warnings.push(format!(
                "第 {} 行的姿势接触切分线，请检查是否有跨格肢体",
                row + 1
            ));
        }
        for col in 0..options.cols {
            if sources.len() >= options.frame_count as usize {
                break;
            }
            let rect = Rect {
                x: cuts[col as usize],
                y: top,
                w: cuts[col as usize + 1] - cuts[col as usize],
                h: bottom - top,
            };
            let cell = image::imageops::crop_imm(&sheet, rect.x, rect.y, rect.w, rect.h).to_image();
            let bounds = alpha_bounds(&cell).ok_or_else(|| {
                format!(
                    "第 {} 帧没有有效角色，请检查帧数、宫格和底色",
                    sources.len() + 1
                )
            })?;
            let anchor = match options.alignment {
                Alignment::Foot => centroid(&cell, bounds, true),
                Alignment::Alpha => centroid(&cell, bounds, false),
                Alignment::None => f64::from(rect.w) / 2.0,
            };
            if options.alignment != Alignment::None {
                let extent =
                    (anchor - f64::from(bounds.x)).max(f64::from(bounds.x + bounds.w) - anchor);
                scale = scale.min((f64::from(cw) / 2.0 - margin_x) / extent.max(1.0));
            }
            scale = scale.min((f64::from(ch) - 2.0 * margin_y) / f64::from(bounds.h));
            analyses.push(FrameAnalysis {
                source_index: sources.len(),
                source_rect: rect,
                content_bounds: bounds,
                anchor_x: anchor,
                offset_x: 0,
                offset_y: 0,
            });
            sources.push(cell);
        }
    }
    // 同一缩放作用于整段动画，不把下蹲/收腿的姿势单独拉高。
    scale = scale.clamp(0.001, 1.0);
    let frames = sources
        .into_iter()
        .zip(analyses.iter_mut())
        .map(|(cell, analysis)| {
            let nw = ((f64::from(cell.width()) * scale).round() as u32).max(1);
            let nh = ((f64::from(cell.height()) * scale).round() as u32).max(1);
            let resized =
                image::imageops::resize(&cell, nw, nh, image::imageops::FilterType::Nearest);
            let resized_bounds = alpha_bounds(&resized).ok_or_else(|| {
                format!(
                    "第 {} 帧缩放后没有有效像素，请减少边距",
                    analysis.source_index + 1
                )
            })?;
            let left = if options.alignment == Alignment::None {
                0
            } else {
                // 最近邻取整后重新求锚点，不能直接缩放旧质心，否则会产生 1px 抖动。
                (f64::from(cw) / 2.0
                    - centroid(
                        &resized,
                        resized_bounds,
                        options.alignment == Alignment::Foot,
                    ))
                .round() as i64
            };
            let top = if options.ground {
                (f64::from(ch) - margin_y - f64::from(resized_bounds.y + resized_bounds.h)).round()
                    as i64
            } else {
                ((f64::from(ch) - f64::from(cell.height()) * scale) / 2.0).round() as i64
            };
            analysis.offset_x = left;
            analysis.offset_y = top;
            let mut frame = RgbaImage::new(cw, ch);
            image::imageops::overlay(&mut frame, &resized, left, top);
            Ok(frame)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(PreparedSprite {
        frames,
        analyses,
        warnings,
    })
}

pub fn curate(frames: &[RgbaImage], edits: Option<&[FrameEdit]>) -> Result<Vec<RgbaImage>, String> {
    let Some(edits) = edits else {
        return Ok(frames.to_vec());
    };
    if edits.len() != frames.len() {
        return Err("帧编排与原图帧数不匹配".into());
    }
    let mut used = vec![false; frames.len()];
    let mut output = Vec::new();
    for edit in edits {
        if edit.source_index >= frames.len() || used[edit.source_index] {
            return Err("帧编排包含重复或无效索引".into());
        }
        used[edit.source_index] = true;
        let source = &frames[edit.source_index];
        if edit.offset_x.unsigned_abs() > source.width()
            || edit.offset_y.unsigned_abs() > source.height()
        {
            return Err("帧偏移超出画布范围".into());
        }
        if !edit.enabled {
            continue;
        }
        let mut frame = RgbaImage::new(source.width(), source.height());
        image::imageops::overlay(
            &mut frame,
            source,
            i64::from(edit.offset_x),
            i64::from(edit.offset_y),
        );
        output.push(frame);
    }
    if output.is_empty() {
        return Err("请至少保留一帧".into());
    }
    Ok(output)
}

pub fn atlas(frames: &[RgbaImage], cols: u32) -> Result<RgbaImage, String> {
    if frames.is_empty() || cols == 0 {
        return Err("图集没有有效帧".into());
    }
    let cols = cols.min(frames.len() as u32);
    let rows = (frames.len() as u32).div_ceil(cols);
    let w = frames[0].width().checked_mul(cols).ok_or("图集尺寸溢出")?;
    let h = frames[0].height().checked_mul(rows).ok_or("图集尺寸溢出")?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("输出图集超过像素限制".into());
    }
    let mut output = RgbaImage::new(w, h);
    for (i, frame) in frames.iter().enumerate() {
        image::imageops::overlay(
            &mut output,
            frame,
            i64::from(i as u32 % cols * frame.width()),
            i64::from(i as u32 / cols * frame.height()),
        );
    }
    Ok(output)
}

pub fn png_bytes(image: RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|_| "PNG 编码失败")?;
    Ok(bytes.into_inner())
}

#[tauri::command]
pub async fn preview_sprite_sheet(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input_path: String,
    options: SpriteOptions,
) -> Result<SpritePreview, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    options.validate()?;
    let input = crate::path_policy::authorize_path(
        &app,
        &input_path,
        crate::path_policy::PathAccess::Read,
    )?;
    let _slot = processing_slot().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare(read_sheet(&input)?, &options)?;
        let image = atlas(&prepared.frames, options.cols)?;
        let (width, height) = image.dimensions();
        Ok(SpritePreview {
            png_base64: STANDARD.encode(png_bytes(image)?),
            width,
            height,
            cell_width: prepared.frames[0].width(),
            cell_height: prepared.frames[0].height(),
            cols: options.cols.min(options.frame_count),
            rows: options.frame_count.div_ceil(options.cols),
            frames: prepared.analyses,
            warnings: prepared.warnings,
        })
    })
    .await
    .map_err(|_| "动画处理任务异常退出".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> SpriteOptions {
        SpriteOptions {
            chroma_key: ChromaKey::Magenta,
            alignment: Alignment::Foot,
            ground: true,
            ..SpriteOptions::grid(2, 1, 2)
        }
    }
    fn sample() -> RgbaImage {
        RgbaImage::from_fn(80, 40, |x, y| {
            let inside = (10..18).contains(&x) && (10..35).contains(&y)
                || (60..68).contains(&x) && (5..30).contains(&y);
            Rgba(if inside {
                [20, 60, 120, 255]
            } else {
                [255, 0, 255, 255]
            })
        })
    }
    #[test]
    fn foot_centres_and_baselines_are_stable() {
        let result = prepare(sample(), &options()).unwrap();
        for frame in &result.frames {
            let bounds = alpha_bounds(frame).unwrap();
            assert!((centroid(frame, bounds, true) - 20.0).abs() <= 0.5);
            assert_eq!(bounds.y + bounds.h, 40);
        }
    }
    #[test]
    fn jump_keeps_vertical_displacement_and_common_scale() {
        let mut opts = options();
        opts.ground = false;
        let result = prepare(sample(), &opts).unwrap();
        let a = alpha_bounds(&result.frames[0]).unwrap();
        let b = alpha_bounds(&result.frames[1]).unwrap();
        assert_eq!(a.h, b.h);
        assert_eq!(a.y - b.y, 5);
    }
    #[test]
    fn resampled_frames_share_exact_ground_line_and_pixel_centres() {
        let mut opts = options();
        opts.margin = 0.2;
        let image = RgbaImage::from_fn(82, 41, |x, y| {
            let inside = (3..20).contains(&x) && (0..39).contains(&y)
                || (59..76).contains(&x) && (8..31).contains(&y);
            Rgba(if inside {
                [20, 60, 120, 255]
            } else {
                [255, 0, 255, 255]
            })
        });
        let result = prepare(image, &opts).unwrap();
        for frame in &result.frames {
            let bounds = alpha_bounds(frame).unwrap();
            assert_eq!(bounds.y + bounds.h, 33);
            assert!((centroid(frame, bounds, true) - 20.5).abs() <= 0.5);
        }
    }
    #[test]
    fn unmixes_soft_edges_without_eroding_opaque_subject() {
        let mut image = RgbaImage::from_pixel(5, 5, Rgba([255, 0, 255, 255]));
        image.put_pixel(2, 2, Rgba([20, 60, 120, 255]));
        image.put_pixel(1, 2, Rgba([128, 0, 128, 255]));
        remove_key(&mut image, [255, 0, 255], false, 55.0);
        assert_eq!(image.get_pixel(0, 0)[3], 0);
        assert!((120..=130).contains(&image.get_pixel(1, 2)[3]));
        assert_eq!(*image.get_pixel(2, 2), Rgba([20, 60, 120, 255]));
    }
    #[test]
    fn auto_does_not_remove_white_clothing_or_background() {
        let image = RgbaImage::from_pixel(40, 40, Rgba([255, 255, 255, 255]));
        assert!(detected_key(&image, ChromaKey::Auto).is_none());
    }
    #[test]
    fn projection_moves_a_cut_into_the_actual_gutter() {
        let image = RgbaImage::from_fn(80, 40, |x, _| {
            Rgba([
                0,
                0,
                0,
                if (5..43).contains(&x) || (50..75).contains(&x) {
                    255
                } else {
                    0
                },
            ])
        });
        let mut opts = options();
        opts.segmentation = Segmentation::Projection;
        let (cuts, touching) = row_boundaries(&image, &opts, 0, 40);
        assert_eq!(cuts[1], 43);
        assert!(!touching);
    }
    #[test]
    fn rejects_empty_frames_invalid_geometry_and_edits() {
        assert!(prepare(RgbaImage::new(80, 40), &options()).is_err());
        assert!(SpriteOptions::grid(u32::MAX, u32::MAX, 2)
            .validate()
            .is_err());
        let frames = prepare(sample(), &options()).unwrap().frames;
        let edits = vec![
            FrameEdit {
                source_index: 0,
                enabled: false,
                offset_x: 0,
                offset_y: 0
            };
            2
        ];
        assert!(curate(&frames, Some(&edits)).is_err());
    }
    #[test]
    fn applies_order_disabled_frames_and_offsets() {
        let frames = vec![
            RgbaImage::from_pixel(4, 4, Rgba([10, 0, 0, 255])),
            RgbaImage::from_pixel(4, 4, Rgba([20, 0, 0, 255])),
        ];
        let edits = vec![
            FrameEdit {
                source_index: 1,
                enabled: true,
                offset_x: 1,
                offset_y: 0,
            },
            FrameEdit {
                source_index: 0,
                enabled: false,
                offset_x: 0,
                offset_y: 0,
            },
        ];
        let output = curate(&frames, Some(&edits)).unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].get_pixel(0, 0)[3], 0);
        assert_eq!(output[0].get_pixel(1, 0)[0], 20);
    }
}
