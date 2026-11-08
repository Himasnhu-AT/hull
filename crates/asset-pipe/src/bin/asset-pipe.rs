//! `asset-pipe <model.gltf|glb> --out <dir> [--name N] [options]`: cook a model (docs/ASSETS.md,
//! "3D pipeline"). Exit 1 when validation fails (without `--force`).

use std::path::PathBuf;

use asset_pipe::collider::ColliderChoice;
use asset_pipe::gltf_in;
use asset_pipe::impostor::BakeConfig;
use asset_pipe::pipeline::{Config, Pipeline, Pivot, Severity, UpAxis};

const USAGE: &str = "usage: asset-pipe <model.gltf|.glb> --out DIR [--name NAME] [--scale K] [--up y|z] [--pivot keep|bottom|center]
       [--height M] [--max-texture PX] [--lods 0.4,0.15] [--distances 20,60,150] [--collider auto|none|box|sphere|capsule|convex|trimesh]
       [--impostor VIEWS[,CELLPX] | --no-impostor] [--impostor-max M] [--tags a,b] [--cook PATH/TO/cook] [--force]";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return;
    }
    let opt = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
    let flag = |n: &str| args.iter().any(|a| a == n);
    let nums = |s: String| -> Vec<f32> { s.split(',').filter_map(|x| x.trim().parse().ok()).collect() };
    let Some(input) = args.first().filter(|a| !a.starts_with("--")).map(PathBuf::from) else { fail(USAGE) };
    let Some(out) = opt("--out").map(PathBuf::from) else { fail(USAGE) };
    let (model, report) = gltf_in::read_file(&input).unwrap_or_else(|e| fail(&e));
    for w in &report.warnings {
        eprintln!("warning: {w}");
    }
    let mut cfg = Config { name: opt("--name").unwrap_or_else(|| model.name.clone()), force: flag("--force"), ..Default::default() };
    if let Some(v) = opt("--scale").and_then(|v| v.parse().ok()) {
        cfg.scale = v;
    }
    cfg.up_axis = if opt("--up").as_deref() == Some("z") { UpAxis::Z } else { UpAxis::Y };
    cfg.pivot = match opt("--pivot").as_deref() {
        Some("keep") => Pivot::Keep,
        Some("center") => Pivot::Center,
        _ => Pivot::BottomCenter,
    };
    cfg.target_height = opt("--height").and_then(|v| v.parse().ok());
    cfg.max_texture_size = opt("--max-texture").and_then(|v| v.parse().ok());
    if let Some(v) = opt("--lods") {
        cfg.lod_ratios = nums(v);
    }
    if let Some(v) = opt("--distances") {
        cfg.lod_distances = nums(v);
    }
    if let Some(c) = opt("--collider") {
        cfg.collider = ColliderChoice::parse(&c).unwrap_or_else(|| fail("unknown --collider"));
    }
    if flag("--no-impostor") {
        cfg.impostor = None;
    } else if let Some(v) = opt("--impostor") {
        let n = nums(v);
        cfg.impostor = Some(BakeConfig { views: n.first().copied().unwrap_or(8.0) as u32, cell: n.get(1).copied().unwrap_or(128.0) as u32, ..Default::default() });
    }
    cfg.impostor_max_distance = opt("--impostor-max").and_then(|v| v.parse().ok());
    if let Some(t) = opt("--tags") {
        cfg.tags = t.split(',').map(str::to_string).collect();
    }
    cfg.cook = opt("--cook").map(PathBuf::from);
    match Pipeline::standard().run(model, &cfg, &out) {
        Ok(a) => {
            for i in &a.issues {
                let tag = match i.severity {
                    Severity::Info => "info",
                    Severity::Warning => "warning",
                    Severity::Error => "error",
                };
                eprintln!("{tag} [{}]: {}", i.stage, i.message);
            }
            let d = a.desc.as_ref().expect("emit ran");
            println!("{}: {} LODs ({:?} triangles), collider {:?}, impostor {}, {} files in {}", d.name, d.lods.len(), d.lods.iter().map(|l| l.triangles).collect::<Vec<_>>(), std::mem::discriminant(&d.collider), d.impostor.is_some(), a.outputs.len(), out.display());
        }
        Err((a, e)) => {
            for i in &a.issues {
                eprintln!("{:?} [{}]: {}", i.severity, i.stage, i.message);
            }
            fail(&e)
        }
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}
