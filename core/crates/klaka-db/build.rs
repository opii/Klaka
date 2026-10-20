// `sqlx::migrate!` ugrađuje migracije pri prevođenju; bez ovoga nova migracija ne ulazi u
// binarni fajl dok se izvorni kod ovog crate-a ne promeni.
fn main() {
    println!("cargo:rerun-if-changed=../../migrations");
}
