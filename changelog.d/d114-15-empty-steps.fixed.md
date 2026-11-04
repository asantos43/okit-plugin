Trajectory readers no longer build a step for a transcript row that carries no text, call, result, usage or other data, so sub-MiB inputs full of such rows are read and saved in well under a second.
 A step that carries data costs a small, bounded amount to read, normalise and save: about a quarter of a second per 10,000 one-line steps, no longer six times the old cost.
