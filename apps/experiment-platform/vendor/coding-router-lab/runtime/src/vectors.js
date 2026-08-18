export const l2Normalize = (values) => {
    const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    if (magnitude === 0)
        throw new Error("Cannot normalize a zero vector");
    return values.map((value) => value / magnitude);
};
export const cosine = (left, right) => {
    if (left.length !== right.length || left.length === 0)
        throw new Error("Vector dimensions differ");
    const a = l2Normalize(left);
    const b = l2Normalize(right);
    return a.reduce((sum, value, index) => sum + value * b[index], 0);
};
export const centroid = (vectors) => {
    if (vectors.length === 0)
        throw new Error("Centroid requires at least one vector");
    const dimensions = vectors[0].length;
    if (!vectors.every((vector) => vector.length === dimensions))
        throw new Error("Vector dimensions differ");
    const sum = new Array(dimensions).fill(0);
    for (const vector of vectors.map(l2Normalize)) {
        vector.forEach((value, index) => { sum[index] = sum[index] + value; });
    }
    return l2Normalize(sum.map((value) => value / vectors.length));
};
