//! Prints the import preview for a texture pack without installing it:
//! `cargo run -p gaming-core --example inspect_pack -- <zip-or-folder> [GAMEID]`

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: inspect_pack <zip-or-folder> [GAMEID]");
    let game = args.next();
    let started = std::time::Instant::now();
    match gaming_core::textures::Source::open(path.as_ref()).and_then(|s| gaming_core::textures::inspect(&s, game.as_deref())) {
        Ok((mut p, _, entries)) => {
            for i in &mut p.instructions {
                i.text = i.text.chars().take(160).collect();
            }
            println!("{}", serde_json::to_string_pretty(&p).unwrap());
            println!("{} entries listed in {:?}", entries.len(), started.elapsed());
        }
        Err(e) => println!("refused: {e}"),
    }
}
