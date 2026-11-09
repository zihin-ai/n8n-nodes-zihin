import {
  Icon,
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class ZihinApi implements ICredentialType {
  name = 'zihinApi';
  displayName = 'Zihin API';
  icon: Icon = { light: 'file:zihin.svg', dark: 'file:zihin.svg' };

  // eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased -- The credential requires an HTTPS URL, not a camelCase value.
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

      baseURL: 'https://llm.zihin.ai',
      url: '/api/v2/agents',
      method: 'GET',
    },
  };
}
