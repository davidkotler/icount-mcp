const BASE_URL = "https://api.icount.co.il";

function getToken() {
  const token = process.env.ICOUNT_API_TOKEN;
  if (!token) {
    throw new Error(
      "ICOUNT_API_TOKEN is not set. Copy .env.example to .env and fill in your iCount API token."
    );
  }
  return token;
}

// Drop undefined/empty-string keys so we don't send noise the API might
// misinterpret (e.g. an empty client_id alongside a client_name).
function clean(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

async function icountRequest(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `iCount returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`
    );
  }

  if (!res.ok || data?.status === false) {
    const message =
      data?.error_description || data?.reason || data?.message || data?.error || JSON.stringify(data);
    throw new Error(`iCount API error (HTTP ${res.status}): ${message}`);
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

export async function listClients({ maxResults } = {}) {
  const data = await icountRequest("POST", "/api/v3.php/client/get_list", { detail_level: 10 });
  const raw = data?.data?.data ?? data?.data ?? data?.clients ?? data;
  const clients = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw).filter((v) => v && typeof v === "object" && !Array.isArray(v))
      : [];
  return maxResults ? clients.slice(0, maxResults) : clients;
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
