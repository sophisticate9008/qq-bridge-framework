//! Framework HTML worker: local input and explicit fonts -> one bounded PNG.
use anyrender::{PaintScene as _, render_to_buffer};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{DocumentConfig, util::Color};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use linebender_resource_handle::Blob;
use parley::{FontContext, fontique::{Collection, CollectionOptions, SourceCache, GenericFamily, Script}};
use peniko::{Fill, kurbo::Rect};
use std::{error::Error, fs, io, sync::Arc, time::Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        return Err("usage: qbf-html-renderer INPUT.html OUTPUT.png WIDTH FONT...".into());
    }
    let html = fs::read_to_string(&args[0])?;
    if html.len() > 4 * 1024 * 1024 {
        return Err("HTML input exceeds 4 MiB".into());
    }
    let width: u32 = args[2].parse()?;
    if !(64..=4096).contains(&width) {
        return Err("width must be between 64 and 4096".into());
    }
    let mut fonts = FontContext {
        source_cache: SourceCache::new_shared(),
        collection: Collection::new(CollectionOptions { shared: false, system_fonts: false }),
    };
    fonts.collection.register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT.to_vec())), None);
    for path in &args[3..] {
        fonts.collection.register_fonts(Blob::new(Arc::new(fs::read(path)?)), None);
    }
    // Explicit collections have no platform generic/fallback maps. Populate both
    // so model-authored CSS naming unavailable system fonts still has glyphs.
    let text_families: Vec<_> = ["WenQuanYi Micro Hei", "Noto Sans", "Noto Sans Math", "Noto Sans Symbols 2"]
        .iter().filter_map(|name| fonts.collection.family_id(name)).collect();
    if text_families.is_empty() { return Err("no framework text fonts loaded".into()); }
    for generic in GenericFamily::all() {
        let mut families = text_families.clone();
        if matches!(generic, GenericFamily::Monospace | GenericFamily::UiMonospace) {
            if let Some(id) = fonts.collection.family_id("WenQuanYi Micro Hei Mono") { families.insert(0, id); }
        }
        fonts.collection.set_generic_families(*generic, families.into_iter());
    }
    for script in [*b"Latn", *b"Hani", *b"Zyyy", *b"Grek", *b"Cyrl", *b"Hira", *b"Kana", *b"Hang"] {
        fonts.collection.set_fallbacks(Script::from_bytes(script), text_families.iter().copied());
    }
    let mut document = HtmlDocument::from_html(&html, DocumentConfig {
        viewport: Some(Viewport::new(width, 1, 1.0, ColorScheme::Light)),
        font_ctx: Some(fonts),
        // No network, filesystem resource provider, scripts, or window shell.
        ..Default::default()
    });
    document.as_mut().resolve(0.0);
    let computed_height = document.as_ref().root_element().final_layout().size.height;
    if !computed_height.is_finite() || computed_height <= 0.0 {
        return Err("invalid document height".into());
    }
    let height = computed_height.ceil() as u32;
    if u64::from(width) * u64::from(height) > 16_777_216 {
        return Err("document exceeds 16777216 pixels".into());
    }
    let rgba = render_to_buffer::<VelloCpuImageRenderer, _>(|scene| {
        scene.fill(Fill::NonZero, Default::default(), Color::WHITE, Default::default(),
            &Rect::new(0.0, 0.0, f64::from(width), f64::from(height)));
        paint_scene(scene, document.as_mut(), 1.0, width, height, 0, 0);
    }, width, height);
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&rgba)?;
        writer.finish()?;
    }
    if png.len() > 8 * 1024 * 1024 {
        return Err(io::Error::other("PNG exceeds 8 MiB").into());
    }
    fs::write(&args[1], &png)?;
    println!("{{\"width\":{width},\"height\":{height},\"pngBytes\":{},\"elapsedMs\":{}}}",
        png.len(), started.elapsed().as_millis());
    Ok(())
}
