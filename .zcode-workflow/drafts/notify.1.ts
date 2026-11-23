phase("探针");
const r1 = await agent("探针一").ask<string>("回复三个字：任务一");
const r2 = await agent("探针二").ask<string>("回复三个字：任务二");
return { r1, r2 };