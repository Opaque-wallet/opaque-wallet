fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc is available");
    std::env::set_var("PROTOC", protoc);
    prost_build::Config::new()
        .compile_protos(&["proto/privacy_signals.proto"], &["proto"])
        .expect("privacy signal protobuf must compile");
}
