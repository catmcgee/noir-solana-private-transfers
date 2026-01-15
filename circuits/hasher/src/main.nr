use dep::poseidon2;

/// Computes commitment and nullifier_hash from deposit secrets
fn main(nullifier: Field, secret: Field, amount: Field) -> pub (Field, Field) {
    let commitment = poseidon2::bn254::hash_3([nullifier, secret, amount]);
    let nullifier_hash = poseidon2::bn254::hash_1([nullifier]);
    (commitment, nullifier_hash)
}

#[test]
fn test_hash_computation() {
    let (c1, n1) = main(12345, 67890, 1000000000);
    let (c2, n2) = main(12345, 67890, 1000000000);

    assert(c1 == c2);
    assert(n1 == n2);
}
