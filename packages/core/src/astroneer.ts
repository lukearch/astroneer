import {
  HttpError,
  HttpServerMethods,
  Logger,
  createFile,
  isDevMode,
} from '@astroneer/common';
import { AstroneerConfig, DIST_FOLDER, loadConfig } from '@astroneer/config';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { UrlWithParsedQuery } from 'url';
import { Request } from './request';
import { Response } from './response';
import {
  AstroneerRouter,
  Route,
  RouteHandler,
  RouteMiddleware,
} from './router';

export type ErrorRouteHandler = (
  err: Error,
  req: Request,
  res: Response,
) => void | Promise<void>;

export class Astroneer {
  private constructor(private router: AstroneerRouter) {}

  static async prepare(): Promise<Astroneer> {
    const router = new AstroneerRouter();
    await router.preloadRoutes();

    if (isDevMode()) {
      const metadata = router.generateRouteMetadata();
      createFile({
        filePath: path.resolve(DIST_FOLDER, 'routes.json'),
        content: metadata,
        overwrite: true,
      });
    }

    return new Astroneer(router);
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: UrlWithParsedQuery,
    customHandlers?: {
      onError?: ErrorRouteHandler;
      onNotFound?: RouteHandler;
    },
  ): Promise<void> {
    const config = loadConfig();
    const route = await this.matchRoute(req, parsedUrl);

    if (!route?.handler) {
      return this.sendNotFound(res);
    }

    const { request, response } = this.prepareRequestAndResponse(
      req,
      res,
      route,
      parsedUrl,
    );

    try {
      await this.runMiddlewares(route.middlewares ?? [], request, response);
      await this.runHandler(route.handler, request, response);
    } catch (err) {
      this.handleError(err, config, request, response, customHandlers);
    }
  }

  private handleError(
    err: Error,
    config: AstroneerConfig,
    req: Request,
    res: Response,
    customHandlers?: {
      onError?: ErrorRouteHandler;
      onNotFound?: RouteHandler;
    },
  ) {
    this.logErrorIfNeeded(err, config);

    if (customHandlers?.onError) {
      return customHandlers.onError(err, req, res);
    }

    if (err.name === HttpError.name) {
      return res
        .status((err as HttpError).statusCode)
        .json((err as HttpError).json());
    }
  }

  private logErrorIfNeeded(err: Error, config: AstroneerConfig) {
    if (config.logger?.httpErrors) {
      Logger.error(err.stack);
    }
  }

  private async matchRoute(
    req: IncomingMessage,
    parsedUrl: UrlWithParsedQuery,
  ) {
    return this.router.match(
      req.method as HttpServerMethods,
      parsedUrl.pathname!,
    );
  }

  private sendNotFound(res: ServerResponse) {
    res.statusCode = 404;
    res.end('Not Found');
  }

  private prepareRequestAndResponse(
    req: IncomingMessage,
    res: ServerResponse,
    route: Route,
    parsedUrl: UrlWithParsedQuery,
  ) {
    const query = Object.fromEntries(
      new URLSearchParams(parsedUrl.search ?? '').entries(),
    );
    const request = new Request(req, route.params, query);
    const response = new Response(res);

    return { request, response };
  }

  private async runMiddlewares(
    middlewares: RouteMiddleware[],
    req: Request,
    res: Response,
  ) {
    if (middlewares.length) {
      await this.runInQueue(middlewares, req, res);
    }
  }

  private async runInQueue(
    middlewares: RouteMiddleware[],
    req: Request,
    res: Response,
  ): Promise<void> {
    const queue = [...middlewares];

    const next = async () => {
      if (queue.length) {
        const middleware = queue.shift();

        try {
          await middleware?.(req, res, next);
        } catch (err) {
          throw err;
        }
      }
    };

    return new Promise<void>((resolve, reject) => {
      next().then(resolve).catch(reject);
    });
  }

  private async runHandler(handler: RouteHandler, req: Request, res: Response) {
    await handler(req, res);
  }
}
