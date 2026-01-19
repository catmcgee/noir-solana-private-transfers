use dep::poseidon;

global TREE_DEPTH: u32 = 10;

/// Computes Merkle root for a leaf at a given index in an otherwise empty tree
fn main(leaf: Field, leaf_index: pub Field) -> pub Field {
    let index = leaf_index as u32;

    // Compute zeros for empty subtrees at each level
    let mut zeros: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    for i in 1..TREE_DEPTH {
        zeros[i] = poseidon::poseidon2::Poseidon2::hash([zeros[i - 1], zeros[i - 1]], 2);
    }

    let mut current = leaf;
    let mut idx = index;

    for i in 0..TREE_DEPTH {
        let is_right = (idx & 1) == 1;
        let sibling = zeros[i];

        current = if is_right {
            poseidon::poseidon2::Poseidon2::hash([sibling, current], 2)
        } else {
            poseidon::poseidon2::Poseidon2::hash([current, sibling], 2)
        };

        idx = idx >> 1;
    }

    current
}

#[test]
fn test_root_computation() {
    let commitment = 0x20fa9463e53cae353b5d5e9bf672116d1cca836c719735d9308d6f4cae2e872d;

    let root_at_0 = main(commitment, 0);
    let root_at_1 = main(commitment, 1);

    std::println(root_at_0);
    std::println(root_at_1);

    // Different indices should produce different roots
    assert(root_at_0 != root_at_1);
}
