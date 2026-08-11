use std::fs;
use std::path::PathBuf;

use uuid::Uuid;

/// A throwaway static dir with just enough on disk (an `index.html` app
/// shell) to exercise `meologue_server::router`'s static-serving fallback.
pub fn make_static_dir(test_name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("meologue-{test_name}-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.html"), "<html>app shell</html>").unwrap();
    dir
}
