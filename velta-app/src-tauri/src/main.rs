// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    velta_app::set_initial_deeplink_from_env();
    velta_app::run();
}
