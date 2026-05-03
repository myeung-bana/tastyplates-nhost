import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { generateOpenAPISpec } from '../_lib/openapi-registry';

const router = Router();

if (process.env.NODE_ENV !== 'production') {
  const spec = generateOpenAPISpec();

  router.get('/docs/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(spec);
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Tastyplates API Docs',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
      },
    })
  );
}

export default router;
