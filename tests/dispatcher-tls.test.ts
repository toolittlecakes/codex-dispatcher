import { describe, expect, test } from "bun:test";
import { coversSubjectAltNames, parseSubjectAltNames, subjectAltNames } from "../src/dispatcher-tls";

describe("dispatcher certificate", () => {
  test("names every address the phone can arrive on, plus loopback", () => {
    expect(subjectAltNames(["192.168.31.240", "10.8.1.1"])).toEqual([
      "DNS:localhost",
      "IP:127.0.0.1",
      "IP:0:0:0:0:0:0:0:1",
      "IP:192.168.31.240",
      "IP:10.8.1.1",
    ]);
  });

  test("reads back the names openssl prints, which spells addresses its own way", () => {
    expect(
      parseSubjectAltNames("X509v3 Subject Alternative Name: \n    DNS:localhost, IP Address:127.0.0.1, IP Address:10.8.1.1\n"),
    ).toEqual(["DNS:localhost", "IP:127.0.0.1", "IP:10.8.1.1"]);
  });

  // The address a laptop hands out changes with the network it joins, and the
  // phone cannot click past a certificate that does not name the current one.
  test("asks for a new certificate once the machine answers on an address it does not name", () => {
    const certificate = ["DNS:localhost", "IP:127.0.0.1", "IP:192.168.31.240"];
    expect(coversSubjectAltNames(certificate, ["DNS:localhost", "IP:192.168.31.240"])).toBe(true);
    expect(coversSubjectAltNames(certificate, ["IP:10.8.1.1"])).toBe(false);
  });
});
