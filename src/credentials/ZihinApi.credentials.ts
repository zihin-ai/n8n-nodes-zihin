import {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class ZihinApi implements ICredentialType {
  name = 'zihinApi';
  displayName = 'Zihin API';
  // eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased -- e uma URL https (exigido por cred-class-field-documentation-url-not-http-url); a regra `miscased` a reescreveria em camelCase
  documentationUrl = 'https://docs.zihin.ai/integrations/n8n';
  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      required: true,
      description: 'Your Zihin API key (format: zhn_live_xxx or zhn_test_xxx)',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        'X-Api-Key': '={{$credentials.apiKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      // Valida a key listando os agentes do tenant (caminho de agente, não a call direta legada).
      baseURL: 'https://llm.zihin.ai',
      url: '/api/v2/agents',
      method: 'GET',
    },
  };
}
