use std::sync::{Arc, Mutex};

pub struct RunningProcess {
    pub child: tokio::process::Child,
}

pub struct ActiveProcess(pub Arc<Mutex<Option<RunningProcess>>>);
