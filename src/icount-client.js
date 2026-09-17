// Thin, dependency-free wrapper around the iCount v3 REST API.
//
// The base URL is deliberately hardcoded rather than read from the environment:
// every request carries a bearer token, and letting an env var redirect that
// traffic would turn a poisoned environment into a token-exfiltration channel.
const BASE_URL = "https://api.icount.co.il";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

// iCount can return very large payloads (a full client list at detail_level 10).
// Refuse absurd ones rather than buffering them into memory and then into an
// LLM context window.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Error carrying the HTTP status, so callers can tell auth from validation failures. */
export class IcountApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "IcountApiError";
    this.status = status;
    this.body = body;
  }
}

function getToken() {
  const token = process.env.ICOUNT_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "ICOUNT_API_TOKEN is not set. Pass it in the `env` block of your MCP client config, " +
        "or put it in a .env file next to the package."
    );
  }
  return token;
}

function getTimeoutMs() {
  const raw = Number(process.env.ICOUNT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// Belt and braces: nothing here logs the token, but error text can echo request
// context back from the far end, so scrub it before it can reach a transcript.
// Only ever applied to error messages — never to a response body on its way to
// JSON.parse, where substring replacement would corrupt valid data.
const MIN_REDACTABLE_TOKEN_LENGTH = 8;

function redact(text, token) {
  if (!text || !token || token.length < MIN_REDACTABLE_TOKEN_LENGTH) return text;
  return String(text).split(token).join("[REDACTED_TOKEN]");
}

// Drop undefined/empty-string keys so we do not send noise the API might
// misinterpret (e.g. an empty client_id alongside a client_name). `0` and
// `false` are meaningful values and are kept.
function clean(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

async function icountRequest(method, path, body) {
  const token = getToken();
  const timeoutMs = getTimeoutMs();
  let res;

  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Without this, a hung request would block the MCP client indefinitely.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new IcountApiError(`iCount request to ${path} timed out after ${timeoutMs}ms.`);
    }
    throw new IcountApiError(
      `Could not reach the iCount API (${path}): ${redact(err?.message, token)}`
    );
  }

  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new IcountApiError(
      `iCount response for ${path} is too large (${declaredLength} bytes). Narrow the request.`,
      { status: res.status }
    );
  }

  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new IcountApiError(`iCount response for ${path} is too large. Narrow the request.`, {
      status: res.status,
    });
  }

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new IcountApiError(
      `iCount returned a non-JSON response (HTTP ${res.status}): ${redact(text.slice(0, 500), token)}`,
      { status: res.status }
    );
  }

  // iCount signals application-level failures with `status: false` and HTTP 200.
  if (!res.ok || data?.status === false) {
    const message =
      data?.error_description || data?.reason || data?.message || data?.error || JSON.stringify(data);
    throw new IcountApiError(
      `iCount API error (HTTP ${res.status}): ${redact(String(message), token)}`,
      { status: res.status, body: data }
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// App / connection
// ---------------------------------------------------------------------------

export function testConnection() {
  return icountRequest("GET", "/api/v3.php/app/info");
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Build the payment sub-object iCount expects for tax documents (receipt /
 * invrec) — without this, creating those doctypes fails validation even
 * though the client record gets created as a side effect. See README.
 */
function buildPaymentBody(payment) {
  if (!payment) return {};
  const { method, sum, ...rest } = payment;
  const sumStr = sum !== undefined ? String(sum) : undefined;

  switch (method) {
    case "cash":
      return { cash: clean({ sum: sumStr }) };
    case "creditcard":
      return {
        cc: clean({
          sum: sumStr,
          date: rest.date,
          num_of_payments: rest.numOfPayments,
          first_payment: rest.firstPayment,
          card_type: rest.cardType,
          card_number: rest.cardNumber,
          exp_year: rest.expYear,
          exp_month: rest.expMonth,
          holder_id: rest.holderId,
          holder_name: rest.holderName,
          confirmation_code: rest.confirmationCode,
        }),
      };
    case "cheque":
      return {
        cheques: [
          clean({
            sum: sumStr,
            date: rest.date,
            bank: rest.bank,
            branch: rest.branch,
            account: rest.account,
            number: rest.chequeNumber,
          }),
        ],
      };
    case "banktransfer":
      return { banktransfer: clean({ sum: sumStr, date: rest.date, account: rest.account }) };
    default:
      return {};
  }
}

export function createDocument(params) {
  const {
    doctype,
    clientId,
    clientName,
    clientEmail,
    clientVatId,
    clientAddress,
    clientCity,
    clientPhone,
    items,
    comments,
    currency,
    lang,
    issueDate,
    dueDate,
    sendEmail,
    payment,
  } = params;

  const body = clean({
    doctype,
    client_id: clientId,
    client_name: clientId ? undefined : clientName,
    email: clientEmail,
    vat_id: clientVatId,
    client_address: clientAddress,
    client_city: clientCity,
    client_phone: clientPhone,
    items,
    hwc: comments,
    currency_code: currency,
    lang,
    doc_date: issueDate,
    duedate: dueDate,
    send_email: sendEmail ? 1 : undefined,
    ...buildPaymentBody(payment),
  });

  return icountRequest("POST", "/api/v3.php/doc/create", body);
}

export function searchDocuments(filters) {
  const { maxResults, detailLevel, ...rest } = filters ?? {};
  return icountRequest("POST", "/api/v3.php/doc/search", {
    ...clean(rest),
    max_results: maxResults ?? 100,
    detail_level: detailLevel ?? 1,
  });
}

export function getDocument({ doctype, docnum, getItems, getPayments, getPdfLink }) {
  return icountRequest(
    "POST",
    "/api/v3.php/doc/info",
    clean({
      doctype,
      docnum,
      get_items: getItems,
      get_payments: getPayments,
      get_pdf_link: getPdfLink,
    })
  );
}

export function cancelDocument({ doctype, docnum, refundCc, reason }) {
  return icountRequest(
    "POST",
    "/api/v3.php/doc/cancel",
    clean({ doctype, docnum, refund_cc: refundCc ? 1 : 0, reason })
  );
}

export function closeDocument({ doctype, docnum, basedOn }) {
  return icountRequest("POST", "/api/v3.php/doc/close", clean({ doctype, docnum, based_on: basedOn }));
}

export function getDocumentConversionOptions({ doctype, docnum }) {
  return icountRequest("POST", "/api/v3.php/doc/get_doc_conversion_options", { doctype, docnum });
}

export function convertDocument({ doctype, docnum, conversionType }) {
  return icountRequest(
    "POST",
    "/api/v3.php/doc/convert",
    clean({ doctype, docnum, conversion_type: conversionType })
  );
}

export function getDocumentUrl({ doctype, docnum, lang, original, hideIls, docLang, emailTo }) {
  return icountRequest(
    "POST",
    "/api/v3.php/doc/get_doc_url",
    clean({
      doctype,
      docnum,
      lang: lang ?? "he",
      orig: original ?? true,
      hidenis: hideIls ?? false,
      doc_lang: docLang,
      email_to: emailTo,
    })
  );
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// iCount is inconsistent about field names between client/create and
// client/update (`vat_id` vs `hp`, `email` vs `client_email`, ...). Sending both
// spellings is what was verified to work against the live API; the server
// ignores whichever one it does not recognise for that endpoint.
function clientBody({ name, vatId, email, phone, mobile, address, city, notes, customClientId, paymentTerms }) {
  return clean({
    client_name: name,
    vat_id: vatId,
    hp: vatId,
    email,
    client_email: email,
    phone,
    client_phone: phone,
    mobile,
    address,
    client_address: address,
    city,
    client_city: city,
    notes,
    custom_client_id: customClientId,
    payment_terms: paymentTerms,
  });
}

export function createClient(params) {
  return icountRequest("POST", "/api/v3.php/client/create", clientBody(params));
}

export function updateClient({ clientId, ...rest }) {
  return icountRequest("POST", "/api/v3.php/client/update", {
    client_id: clientId,
    ...clientBody(rest),
  });
}

export function getClient({ clientId }) {
  return icountRequest("POST", "/api/v3.php/client/info", { client_id: clientId });
}

// Bounded by default: an unbounded detail_level-10 dump of a real account is
// megabytes of JSON, all of which would land in the agent's context.
export async function listClients({ maxResults = 100, detailLevel = 1 } = {}) {
  const data = await icountRequest("POST", "/api/v3.php/client/get_list", {
    detail_level: detailLevel,
  });
  // The shape varies with detail_level: sometimes a bare array, sometimes an
  // id-keyed object, sometimes wrapped one or two levels deep under `data`.
  const raw = data?.data?.data ?? data?.data ?? data?.clients ?? data;
  const clients = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw).filter((v) => v && typeof v === "object" && !Array.isArray(v))
      : [];
  return {
    total: clients.length,
    returned: Math.min(clients.length, maxResults),
    clients: clients.slice(0, maxResults),
  };
}

export function deleteClient({ clientId }) {
  return icountRequest("POST", "/api/v3.php/client/delete", { client_id: clientId });
}

export function getClientOpenDocs({ clientId, doctype, getItems, email, clientName }) {
  return icountRequest(
    "POST",
    "/api/v3.php/client/get_open_docs",
    clean({ client_id: clientId, doctype, get_items: getItems, email, client_name: clientName })
  );
}
