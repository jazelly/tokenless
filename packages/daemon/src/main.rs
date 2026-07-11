use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::net::IpAddr;
use std::path::PathBuf;
use tokenless_daemon::{
    native_binary_build_info, native_host::run_native_host_stdio, serve_http, CompleteJob,
    CreateJob, DaemonError, JobStatus, JobStore, ListJobs, Result,
};

#[derive(Debug, Parser)]
#[command(name = "tokenless-daemon")]
#[command(about = "Tokenless local Rust control-plane foundation.")]
struct Cli {
    #[arg(long, global = true, env = "TOKENLESS_HOME")]
    home: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Init,
    Create {
        #[arg(long)]
        provider: String,
        #[arg(long)]
        action: String,
        #[arg(long)]
        request_json: String,
        #[arg(long)]
        job_id: Option<String>,
        #[arg(long)]
        claim_token: Option<String>,
    },
    List {
        #[arg(long)]
        status: Option<StatusArg>,
        #[arg(long)]
        limit: Option<usize>,
    },
    Get {
        job_id: String,
    },
    Claim {
        job_id: String,
        #[arg(long)]
        claim_token: String,
    },
    Complete {
        job_id: String,
        #[arg(long)]
        claim_token: String,
        #[arg(long)]
        result_json: Option<String>,
        #[arg(long)]
        error_json: Option<String>,
    },
    Serve {
        #[arg(long, default_value = "127.0.0.1")]
        host: IpAddr,
        #[arg(long, default_value_t = 7331)]
        port: u16,
    },
    NativeHost {
        #[arg(
            value_name = "BROWSER_ARG",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        _browser_args: Vec<OsString>,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum StatusArg {
    Queued,
    Claimed,
    Running,
    Succeeded,
    Failed,
    Canceled,
    TimedOut,
}

impl From<StatusArg> for JobStatus {
    fn from(value: StatusArg) -> Self {
        match value {
            StatusArg::Queued => Self::Queued,
            StatusArg::Claimed => Self::Claimed,
            StatusArg::Running => Self::Running,
            StatusArg::Succeeded => Self::Succeeded,
            StatusArg::Failed => Self::Failed,
            StatusArg::Canceled => Self::Canceled,
            StatusArg::TimedOut => Self::TimedOut,
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() == 1 && arguments[0] == "--tokenless-build-info" {
        return print_json(&native_binary_build_info("tokenless-daemon"));
    }
    let cli = Cli::parse();
    let store = match cli.home {
        Some(home) => JobStore::open(home)?,
        None => JobStore::open_default()?,
    };

    match cli.command {
        Command::Init => print_json(&json!({
            "home_dir": store.home_dir(),
            "database_path": store.database_path(),
            "control_token_path": store.control_token_path(),
        })),
        Command::Create {
            provider,
            action,
            request_json,
            job_id,
            claim_token,
        } => {
            let request_json = parse_json_arg("request-json", &request_json)?;
            let mut input = CreateJob::new(provider, action, request_json);
            input.job_id = job_id;
            input.claim_token = claim_token;
            print_json(&store.create_job(input)?.with_claim_token())
        }
        Command::List { status, limit } => print_json(
            &store
                .list_jobs(ListJobs {
                    status: status.map(Into::into),
                    limit,
                    ..ListJobs::default()
                })?
                .iter()
                .map(|job| job.public_view())
                .collect::<Vec<_>>(),
        ),
        Command::Get { job_id } => print_json(&store.get_job(&job_id)?.public_view()),
        Command::Claim {
            job_id,
            claim_token,
        } => print_json(&store.claim_job(&job_id, &claim_token)?.public_view()),
        Command::Complete {
            job_id,
            claim_token,
            result_json,
            error_json,
        } => {
            let completion = match (result_json, error_json) {
                (Some(result_json), None) => CompleteJob::Succeeded {
                    result_json: parse_json_arg("result-json", &result_json)?,
                },
                (None, Some(error_json)) => CompleteJob::Failed {
                    error_json: parse_json_arg("error-json", &error_json)?,
                },
                _ => {
                    return Err(DaemonError::InvalidInput(
                        "pass exactly one of --result-json or --error-json".to_owned(),
                    ))
                }
            };
            print_json(
                &store
                    .complete_job(&job_id, &claim_token, completion)?
                    .public_view(),
            )
        }
        Command::Serve { host, port } => serve_http(store, host, port).await,
        Command::NativeHost { .. } => run_native_host_stdio(store),
    }
}

fn parse_json_arg(name: &str, value: &str) -> Result<Value> {
    serde_json::from_str(value)
        .map_err(|error| DaemonError::InvalidInput(format!("{name} must be valid JSON: {error}")))
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
