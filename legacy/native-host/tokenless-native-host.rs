use tokenless_daemon::native_host::{
    resolve_native_host_home_from_environment, run_native_host_stdio,
};
use tokenless_daemon::{native_binary_build_info, JobStore, Result};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() == 1 && arguments[0] == "--tokenless-build-info" {
        println!(
            "{}",
            serde_json::to_string(&native_binary_build_info("tokenless-native-host"))?
        );
        return Ok(());
    }
    let home = resolve_native_host_home_from_environment()?;
    run_native_host_stdio(JobStore::open(home)?)
}
