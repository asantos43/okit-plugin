// The refusal of an operation: the arguments it was given are not the ones it
// takes. It is a TypeError (the arguments are of the wrong type) and it carries
// the kind 'usage', so the command line answers 2 and a tool answers in its
// own way. The name does not end in "Error" on purpose: this class is the
// refusal of the core, not a failure of the program.

export class Refusal extends TypeError {
  constructor(message, kind = 'usage') {
    super(message);
    this.name = 'Refusal';
    this.kind = kind;
  }
}
