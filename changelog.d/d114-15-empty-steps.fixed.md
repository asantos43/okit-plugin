Trajectory readers no longer build a step for a transcript row that carries no text, call, result, usage or other data, so sub-MiB inputs full of such rows are read and saved in well under a second.
 A step that carries data costs a small, bounded amount to read, normalise and save: a MiB of one-line steps is read and normalised in about half the previous time.
