import { charset, escapedSequences } from "./utils/utf-8";
import {
  StringBuilder,
  NonBufferedString,
  BufferedString,
} from "./utils/bufferedString";
import { TokenType } from "./utils/constants";

const {
  LEFT_BRACE,
  RIGHT_BRACE,
  LEFT_BRACKET,
  RIGHT_BRACKET,
  COLON,
  COMMA,
  TRUE,
  FALSE,
  NULL,
  STRING,
  NUMBER,
} = TokenType;

// Tokenizer States
enum TokenizerStates {
  START,
  STOP,
  ERROR,
  TRUE1,
  TRUE2,
  TRUE3,
  FALSE1,
  FALSE2,
  FALSE3,
  FALSE4,
  NULL1,
  NULL2,
  NULL3,
  STRING_DEFAULT,
  STRING_AFTER_BACKSLASH,
  STRING_UNICODE_DIGIT_1,
  STRING_UNICODE_DIGIT_2,
  STRING_UNICODE_DIGIT_3,
  STRING_UNICODE_DIGIT_4,
  STRING_INCOMPLETE_CHAR,
  NUMBER_AFTER_INITIAL_MINUS,
  NUMBER_AFTER_INITIAL_ZERO,
  NUMBER_AFTER_INITIAL_NON_ZERO,
  NUMBER_AFTER_FULL_STOP,
  NUMBER_AFTER_DECIMAL,
  NUMBER_AFTER_E,
  NUMBER_AFTER_E_AND_SIGN,
  NUMBER_AFTER_E_AND_DIGIT,
}

export interface TokenizerOptions {
  stringBufferSize?: number;
  numberBufferSize?: number;
}

const defaultOpts: TokenizerOptions = {
  stringBufferSize: 0,
  numberBufferSize: 0,
};

export default class AsyncTokenizer {
  private state = TokenizerStates.START;

  private bufferedString: StringBuilder;
  private bufferedNumber: StringBuilder;

  private unicode: string | undefined = undefined; // unicode escapes
  private highSurrogate: number | undefined = undefined;
  private bytesRemaining = 0; // number of bytes remaining in multi byte utf8 char to read after split boundary
  private bytesInSequence = 0; // bytes in multi byte utf8 char to read
  private charSplitBuffer = new Uint8Array(4); // for rebuilding chars split before boundary is reached
  private encoder = new TextEncoder();
  private offset = -1;

  constructor(opts: TokenizerOptions) {
    opts = { ...defaultOpts, ...opts };

    this.bufferedString = opts.stringBufferSize && opts.stringBufferSize > 4
      ? new BufferedString(opts.stringBufferSize)
      : new NonBufferedString();
    this.bufferedNumber = opts.numberBufferSize && opts.numberBufferSize > 0
      ? new BufferedString(opts.numberBufferSize)
      : new NonBufferedString();
  }

  public async write(input: Iterable<number> | string): Promise<void> {
    let buffer: Uint8Array;
    if (input instanceof Uint8Array) {
      buffer = input;
    } else if (typeof input === 'string') {
      buffer = this.encoder.encode(input);
    } else if ((input as any).buffer || Array.isArray(input)) {
      buffer = Uint8Array.from(input);
    } else {
      throw new TypeError(
        'Unexpected type. The `write` function only accepts TypeArrays and Strings.',
      );
    }

    for (let i = 0; i < buffer.length; i += 1) {
      const n = buffer[i]; // get current byte from buffer
      switch (this.state) {
        case TokenizerStates.START:
          this.offset += 1;

          if (
            n === charset.SPACE ||
            n === charset.NEWLINE ||
            n === charset.CARRIAGE_RETURN ||
            n === charset.TAB
          ) {
            // whitespace
            continue;
          }

          if (n === charset.LEFT_CURLY_BRACKET) {
            await this.onToken(LEFT_BRACE, '{', this.offset);
            continue;
          }
          if (n === charset.RIGHT_CURLY_BRACKET) {
            await this.onToken(RIGHT_BRACE, '}', this.offset);
            continue;
          }
          if (n === charset.LEFT_SQUARE_BRACKET) {
            await this.onToken(LEFT_BRACKET, '[', this.offset);
            continue;
          }
          if (n === charset.RIGHT_SQUARE_BRACKET) {
            await this.onToken(RIGHT_BRACKET, ']', this.offset);
            continue;
          }
          if (n === charset.COLON) {
            await this.onToken(COLON, ':', this.offset);
            continue;
          }
          if (n === charset.COMMA) {
            await this.onToken(COMMA, ',', this.offset);
            continue;
          }

          if (n === charset.LATIN_SMALL_LETTER_T) {
            this.state = TokenizerStates.TRUE1;
            continue;
          }

          if (n === charset.LATIN_SMALL_LETTER_F) {
            this.state = TokenizerStates.FALSE1;
            continue;
          }

          if (n === charset.LATIN_SMALL_LETTER_N) {
            this.state = TokenizerStates.NULL1;
            continue;
          }

          if (n === charset.QUOTATION_MARK) {
            this.bufferedString.reset();
            this.state = TokenizerStates.STRING_DEFAULT;
            continue;
          }

          if (n >= charset.DIGIT_ONE && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.reset();
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_INITIAL_NON_ZERO;
            continue;
          }

          if (n === charset.DIGIT_ZERO) {
            this.bufferedNumber.reset();
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_INITIAL_ZERO;
            continue;
          }

          if (n === charset.HYPHEN_MINUS) {
            this.bufferedNumber.reset();
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_INITIAL_MINUS;
            continue;
          }

          break;
        // STRING
        case TokenizerStates.STRING_DEFAULT:
          if (n === charset.QUOTATION_MARK) {
            const str = this.bufferedString.toString();
            await this.onToken(STRING, str, this.offset);
            this.offset += this.bufferedString.byteLength + 1;
            this.state = TokenizerStates.START;
            continue;
          }

          if (n === charset.REVERSE_SOLIDUS) {
            this.state = TokenizerStates.STRING_AFTER_BACKSLASH;
            continue;
          }

          if (n >= 128) { // Parse multi byte (>=128) chars one at a time
            if (n >= 194 && n <= 223) {
              this.bytesInSequence = 2;
            } else if (n <= 239) {
              this.bytesInSequence = 3;
            } else {
              this.bytesInSequence = 4;
            }

            if (this.bytesInSequence <= buffer.length - i) {
              // if bytes needed to complete char fall outside buffer length, we have a boundary split
              this.bufferedString.appendBuf(
                buffer,
                i,
                i + this.bytesInSequence,
              );
              i += this.bytesInSequence - 1;
              continue;
            }

            this.bytesRemaining = i + this.bytesInSequence - buffer.length;
            this.charSplitBuffer.set(buffer.subarray(i));
            i = buffer.length - 1;
            this.state = TokenizerStates.STRING_INCOMPLETE_CHAR;
            continue;
          }

          if (n >= charset.SPACE) {
            this.bufferedString.appendChar(n);
            continue;
          }

          break;
        case TokenizerStates.STRING_INCOMPLETE_CHAR:
          // check for carry over of a multi byte char split between data chunks
          // & fill temp buffer it with start of this data chunk up to the boundary limit set in the last iteration
          this.charSplitBuffer.set(
            buffer.subarray(i, i + this.bytesRemaining),
            this.bytesInSequence - this.bytesRemaining,
          );
          this.bufferedString.appendBuf(
            this.charSplitBuffer,
            0,
            this.bytesInSequence,
          );
          i = this.bytesRemaining - 1;
          this.state = TokenizerStates.STRING_DEFAULT;
          continue;
        case TokenizerStates.STRING_AFTER_BACKSLASH:
          const controlChar = escapedSequences[n];
          if (controlChar) {
            this.bufferedString.appendChar(controlChar);
            this.state = TokenizerStates.STRING_DEFAULT;
            continue;
          }

          if (n === charset.LATIN_SMALL_LETTER_U) {
            this.unicode = '';
            this.state = TokenizerStates.STRING_UNICODE_DIGIT_1;
            continue;
          }

          break;
        case TokenizerStates.STRING_UNICODE_DIGIT_1:
        case TokenizerStates.STRING_UNICODE_DIGIT_2:
        case TokenizerStates.STRING_UNICODE_DIGIT_3:
          if (
            (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) ||
            (n >= charset.LATIN_CAPITAL_LETTER_A &&
              n <= charset.LATIN_CAPITAL_LETTER_F) ||
            (n >= charset.LATIN_SMALL_LETTER_A &&
              n <= charset.LATIN_SMALL_LETTER_F)
          ) {
            this.unicode += String.fromCharCode(n);
            this.state += 1;
            continue;
          }
          break;
        case TokenizerStates.STRING_UNICODE_DIGIT_4:
          if (
            (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) ||
            (n >= charset.LATIN_CAPITAL_LETTER_A &&
              n <= charset.LATIN_CAPITAL_LETTER_F) ||
            (n >= charset.LATIN_SMALL_LETTER_A &&
              n <= charset.LATIN_SMALL_LETTER_F)
          ) {
            const intVal = parseInt(this.unicode + String.fromCharCode(n), 16);
            if (this.highSurrogate === undefined) {
              if (intVal >= 0xD800 && intVal <= 0xDBFF) { // <55296,56319> - highSurrogate
                this.highSurrogate = intVal;
              } else {
                this.bufferedString.appendBuf(
                  this.encoder.encode(String.fromCharCode(intVal)),
                );
              }
            } else {
              if (intVal >= 0xDC00 && intVal <= 0xDFFF) { // <56320,57343> - lowSurrogate
                this.bufferedString.appendBuf(
                  this.encoder.encode(
                    String.fromCharCode(this.highSurrogate, intVal),
                  ),
                );
              } else {
                this.bufferedString.appendBuf(
                  this.encoder.encode(String.fromCharCode(this.highSurrogate)),
                );
              }
              this.highSurrogate = undefined;
            }
            this.state = TokenizerStates.STRING_DEFAULT;
            continue;
          }
        // Number
        // tslint:disable-next-line:no-switch-case-fall-through
        case TokenizerStates.NUMBER_AFTER_INITIAL_MINUS:
          if (n === charset.DIGIT_ZERO) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_INITIAL_ZERO;
            continue;
          }

          if (n >= charset.DIGIT_ONE && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_INITIAL_NON_ZERO;
            continue;
          }

          break;
        case TokenizerStates.NUMBER_AFTER_INITIAL_ZERO:
          if (n === charset.FULL_STOP) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_FULL_STOP;
            continue;
          }

          if (
            n === charset.LATIN_SMALL_LETTER_E ||
            n === charset.LATIN_CAPITAL_LETTER_E
          ) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_E;
            continue;
          }

          i -= 1;
          await this.emitNumber();
          this.state = TokenizerStates.START;
          continue;
        case TokenizerStates.NUMBER_AFTER_INITIAL_NON_ZERO:
          if (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.appendChar(n);
            continue;
          }

          if (n === charset.FULL_STOP) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_FULL_STOP;
            continue;
          }

          if (
            n === charset.LATIN_SMALL_LETTER_E ||
            n === charset.LATIN_CAPITAL_LETTER_E
          ) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_E;
            continue;
          }

          i -= 1;
          await this.emitNumber();
          this.state = TokenizerStates.START;
          continue;
        case TokenizerStates.NUMBER_AFTER_FULL_STOP:
          if (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_DECIMAL;
            continue;
          }

          break;
        case TokenizerStates.NUMBER_AFTER_DECIMAL:
          if (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.appendChar(n);
            continue;
          }

          if (
            n === charset.LATIN_SMALL_LETTER_E ||
            n === charset.LATIN_CAPITAL_LETTER_E
          ) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_E;
            continue;
          }

          i -= 1;
          await this.emitNumber();
          this.state = TokenizerStates.START;
          continue;
        case TokenizerStates.NUMBER_AFTER_E:
          if (n === charset.PLUS_SIGN || n === charset.HYPHEN_MINUS) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_E_AND_SIGN;
            continue;
          }
        // Allow cascading
        // tslint:disable-next-line:no-switch-case-fall-through
        case TokenizerStates.NUMBER_AFTER_E_AND_SIGN:
          if (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.appendChar(n);
            this.state = TokenizerStates.NUMBER_AFTER_E_AND_DIGIT;
            continue;
          }

          break;
        case TokenizerStates.NUMBER_AFTER_E_AND_DIGIT:
          if (n >= charset.DIGIT_ZERO && n <= charset.DIGIT_NINE) {
            this.bufferedNumber.appendChar(n);
            continue;
          }

          i -= 1;
          await this.emitNumber();
          this.state = TokenizerStates.START;
          continue;
        // TRUE
        case TokenizerStates.TRUE1:
          if (n === charset.LATIN_SMALL_LETTER_R) {
            this.state = TokenizerStates.TRUE2;
            continue;
          }
          break;
        case TokenizerStates.TRUE2:
          if (n === charset.LATIN_SMALL_LETTER_U) {
            this.state = TokenizerStates.TRUE3;
            continue;
          }
          break;
        case TokenizerStates.TRUE3:
          if (n === charset.LATIN_SMALL_LETTER_E) {
            this.state = TokenizerStates.START;
            await this.onToken(TRUE, true, this.offset);
            this.offset += 3;
            continue;
          }
          break;
        // FALSE
        case TokenizerStates.FALSE1:
          if (n === charset.LATIN_SMALL_LETTER_A) {
            this.state = TokenizerStates.FALSE2;
            continue;
          }
          break;
        case TokenizerStates.FALSE2:
          if (n === charset.LATIN_SMALL_LETTER_L) {
            this.state = TokenizerStates.FALSE3;
            continue;
          }
          break;
        case TokenizerStates.FALSE3:
          if (n === charset.LATIN_SMALL_LETTER_S) {
            this.state = TokenizerStates.FALSE4;
            continue;
          }
          break;
        case TokenizerStates.FALSE4:
          if (n === charset.LATIN_SMALL_LETTER_E) {
            this.state = TokenizerStates.START;
            await this.onToken(FALSE, false, this.offset);
            this.offset += 4;
            continue;
          }
          break;
        // NULL
        case TokenizerStates.NULL1:
          if (n === charset.LATIN_SMALL_LETTER_U) {
            this.state = TokenizerStates.NULL2;
            continue;
          }
        // tslint:disable-next-line:no-switch-case-fall-through
        case TokenizerStates.NULL2:
          if (n === charset.LATIN_SMALL_LETTER_L) {
            this.state = TokenizerStates.NULL3;
            continue;
          }
        // tslint:disable-next-line:no-switch-case-fall-through
        case TokenizerStates.NULL3:
          if (n === charset.LATIN_SMALL_LETTER_L) {
            this.state = TokenizerStates.START;
            await this.onToken(NULL, null, this.offset);
            this.offset += 3;
            continue;
          }
      }

      throw new Error(
        `Unexpected "${String.fromCharCode(n)}" at position "${i}" in state ${
        TokenizerStates[this.state]
        }`,
      );
    }
  }

  private async emitNumber(): Promise<void> {
    await this.onToken(
      NUMBER,
      this.parseNumber(this.bufferedNumber.toString()),
      this.offset,
    );
    this.offset += this.bufferedNumber.byteLength - 1;
  }

  protected parseNumber(numberStr: string): number {
    return Number(numberStr);
  }

  public async onToken(token: TokenType, value: any, offset: number): Promise<void> {
    // Override
  }
}
