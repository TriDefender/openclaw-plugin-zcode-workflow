phase("探针");
const r1 = agent("探针一").ask("回复三个字：任务一");
const r2 = agent("探针二").ask("回复三个字：任务二");
return { r1, r2 };
