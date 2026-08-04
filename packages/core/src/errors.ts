/** Errors the flasher can raise, with enough context to tell the user what to do. */

/** Base class for everything this library throws on purpose. */
export class EmsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No cart was found, or the browser/OS would not let us claim it. */
export class CartNotFoundError extends EmsError {}

/** The cart stopped answering. Almost always fixed by replugging it. */
export class CartTimeoutError extends EmsError {
  constructor(operation: string, timeoutMs: number, options?: ErrorOptions) {
    super(
      `USB ${operation} timed out after ${timeoutMs} ms. ` +
        "The cart is not answering: unplug it, plug it back in and try again.",
      options,
    );
  }
}

/** A transfer would have fallen outside the addressable memory of the cart. */
export class OutOfRangeError extends EmsError {}

/** The file does not fit in the space it is being written to. */
export class FileTooLargeError extends EmsError {
  constructor(
    readonly fileSize: number,
    readonly capacity: number,
    target: string,
  ) {
    super(
      `the file is ${fileSize} bytes but ${target} holds only ${capacity} bytes`,
    );
  }
}

/** The user (or the UI) asked to stop mid-transfer. */
export class AbortedError extends EmsError {
  constructor(bytesDone: number) {
    super(`transfer aborted after ${bytesDone} bytes`);
  }
}
