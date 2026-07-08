import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const { combine, timestamp, colorize, printf, errors } = winston.format;

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss.SSS' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack }) => {
    const line = `${ts} [${level}] ${message}`;
    return stack ? `${line}\n${stack}` : line;
  }),
);

const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  errors({ stack: true }),
  winston.format.json(),
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new DailyRotateFile({
      filename: path.join('logs', '%DATE%-combined.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: fileFormat,
    }),
  ],
});
