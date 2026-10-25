import unittest
from unittest import mock

import carddav

CARD = "\nFN:Bea Friend&#13;\nitem1.EMAIL;TYPE=INTERNET:Bea@Example.com&#13;\n"


class VcardMatching(unittest.TestCase):
    def test_clean_vcard_drops_trailing_carriage_returns(self):
        self.assertEqual(carddav.clean_vcard("  Bea Friend&#13;&#13; "), "Bea Friend")

    def test_name_comes_from_a_card_whose_email_matches(self):
        self.assertEqual(carddav.matched_name(CARD, " bea@example.com&#13;"), "Bea Friend")

    def test_no_name_when_the_email_does_not_match(self):
        self.assertIsNone(carddav.matched_name(CARD, "other@example.com"))

    def test_card_without_emails_uses_its_name(self):
        self.assertEqual(carddav.matched_name("\nFN:Solo&#13;\n", "bea@example.com"), "Solo")

    def test_card_without_a_name_gives_none(self):
        self.assertIsNone(carddav.matched_name("\nEMAIL:bea@example.com\n", "bea@example.com"))

    def test_query_filters_on_the_cleaned_lowercase_address(self):
        self.assertIn(">bea@example.com</c:text-match>", carddav.addressbook_query("Bea@Example.com&#13;"))


class Requests(unittest.TestCase):
    def setUp(self):
        carddav.conns = {}
        carddav.auth = "Basic x"

    def test_href_reads_the_tagged_href(self):
        xml = "<d:current-user-principal>\n <d:href>/123/principal/</d:href></d:current-user-principal>"
        self.assertEqual(carddav.href(xml, "current-user-principal"), "/123/principal/")
        self.assertIsNone(carddav.href("<d:other/>", "current-user-principal"))

    def test_request_path_defaults_to_root(self):
        self.assertEqual(carddav.request_path(""), "/")
        self.assertEqual(carddav.request_path("/card/"), "/card/")

    def test_req_reuses_one_connection_per_host(self):
        with mock.patch.object(carddav.http.client, "HTTPSConnection") as made:
            made.return_value.getresponse.return_value.status = 207
            made.return_value.getresponse.return_value.read.return_value = b"<ok/>"
            first = carddav.req("REPORT", "https://contacts.icloud.com/card/", "<q/>", "1")
            carddav.req("PROPFIND", "https://contacts.icloud.com", "<q/>")
        self.assertEqual(first, (207, "<ok/>"))
        self.assertEqual(made.call_count, 1)
        sent = made.return_value.request.call_args_list
        self.assertEqual(sent[0].args[:2], ("REPORT", "/card/"))
        self.assertEqual(sent[0].kwargs["headers"]["Depth"], "1")
        self.assertEqual(sent[1].args[:2], ("PROPFIND", "/"))


if __name__ == "__main__":
    unittest.main()
