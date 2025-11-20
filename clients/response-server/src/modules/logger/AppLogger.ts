import pino, {
  type LoggerOptions,
  type Logger as PinoLogger,
  stdSerializers,
} from 'pino';
import pc from 'picocolors';

type LogMeta = Record<string, unknown>;

type Loggable = LogMeta | string;

type LogLevel = 'info' | 'warn' | 'error';

function isString(value: Loggable): value is string {
  return typeof value === 'string';
}

const defaultOptions: LoggerOptions = {
  level: 'info',
  serializers: {
    error: stdSerializers.err,
  },
};

export class AppLogger {
  static readonly colors = {
    network: (value: string) => pc.magenta(value),
    txid: (value: string) => pc.cyan(value),
    value: (value: string | number) => pc.white(String(value)),
    hint: (value: string | number) => pc.blue(String(value)),
    warning: (value: string) => pc.yellow(value),
    error: (value: string) => pc.red(value),
  };

  private constructor(private readonly base: PinoLogger) {}

  static create(options?: LoggerOptions): AppLogger {
    return new AppLogger(pino({ ...defaultOptions, ...options }));
  }

  info(metaOrMsg: Loggable, message?: string) {
    this.log('info', metaOrMsg, message, (msg) => pc.cyan(msg));
  }

  success(metaOrMsg: Loggable, message?: string) {
    this.log('info', metaOrMsg, message, (msg) => pc.green(msg));
  }

  pending(metaOrMsg: Loggable, message?: string) {
    this.log('info', metaOrMsg, message, (msg) => pc.yellow(msg));
  }

  warn(metaOrMsg: Loggable, message?: string) {
    this.log('warn', metaOrMsg, message, (msg) => pc.yellow(msg));
  }

  error(metaOrMsg: Loggable, message?: string) {
    this.log('error', metaOrMsg, message, (msg) => pc.red(msg));
  }

  private log(
    level: LogLevel,
    metaOrMsg: Loggable,
    message: string | undefined,
    colorize: (msg: string) => string
  ) {
    const loggerFn = this.base[level].bind(this.base);

    if (isString(metaOrMsg)) {
      loggerFn(colorize(metaOrMsg));
      return;
    }

    if (message) {
      loggerFn(metaOrMsg, colorize(message));
      return;
    }

    loggerFn(metaOrMsg);
  }
}
