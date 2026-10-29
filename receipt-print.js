(function () {
  const PAPER_WIDTH_MM = 58;
  const SCALE = 3;
  const WIDTH = Math.round(PAPER_WIDTH_MM * 96 / 25.4);
  const PADDING = 8;
  const INK_WIDTH = WIDTH - PADDING * 2;

  function formatAmount(value) {
    return (Number(value) || 0).toFixed(2);
  }

  function amountInWords(value) {
    const ones = [
      'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
      'Seventeen', 'Eighteen', 'Nineteen'
    ];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const underThousand = number => {
      let words = '';
      if (number >= 100) {
        words += `${ones[Math.floor(number / 100)]} Hundred`;
        number %= 100;
        if (number) words += ' ';
      }
      if (number >= 20) {
        words += tens[Math.floor(number / 10)];
        number %= 10;
        if (number) words += ` ${ones[number]}`;
      } else if (number > 0) {
        words += ones[number];
      }
      return words;
    };

    let remaining = Math.max(0, Math.round((Number(value) || 0) * 100));
    const rupees = Math.floor(remaining / 100);
    const paise = remaining % 100;
    remaining = rupees;
    const groups = [
      [10000000, 'Crore'],
      [100000, 'Lakh'],
      [1000, 'Thousand'],
      [1, '']
    ];
    const words = [];

    groups.forEach(([size, label]) => {
      if (remaining < size) return;
      const count = Math.floor(remaining / size);
      remaining %= size;
      words.push(`${underThousand(count)}${label ? ` ${label}` : ''}`);
    });

    const result = `${words.join(' ') || 'Zero'} Rupees`;
    return paise ? `${result} and ${underThousand(paise)} Paise Only` : `${result} Only`;
  }

  function addWrappedText(commands, ctx, text, x, y, maxWidth, font, lineHeight, align) {
    ctx.font = font;
    const words = String(text).split(/\s+/).flatMap(word => {
      if (ctx.measureText(word).width <= maxWidth) return [word];
      const fragments = [];
      let fragment = '';
      Array.from(word).forEach(character => {
        const candidate = fragment + character;
        if (fragment && ctx.measureText(candidate).width > maxWidth) {
          fragments.push(fragment);
          fragment = character;
        } else {
          fragment = candidate;
        }
      });
      if (fragment) fragments.push(fragment);
      return fragments;
    });
    let line = '';
    const lines = [];

    words.forEach(word => {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    if (line) lines.push(line);

    lines.forEach(value => {
      const textAlign = align || 'left';
      const textX = textAlign === 'center' ? x + maxWidth / 2 : x;
      commands.push({ type: 'text', text: value, x: textX, y, font, align: textAlign });
      y += lineHeight;
    });
    return y;
  }

  function createReceiptPng(booking) {
    if (!booking || !Array.isArray(booking.items)) {
      throw new Error('Receipt data is incomplete.');
    }

    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    if (!measureContext) throw new Error('This browser cannot render receipt images.');

    const commands = [];
    let y = PADDING;
    const regularFont = '10px Arial, Helvetica, sans-serif';
    const boldFont = 'bold 10px Arial, Helvetica, sans-serif';
    const lineHeight = 13;
    const numberX = PADDING;
    const itemX = PADDING + 18;
    const qtyX = PADDING + 110;
    const rateX = PADDING + 157;
    const totalX = WIDTH - PADDING;
    const itemWidth = qtyX - itemX - 10;

    y = addWrappedText(commands, measureContext, 'N CAFE', PADDING, y, INK_WIDTH, 'bold 18px Arial, Helvetica, sans-serif', 22, 'center');
    y = addWrappedText(commands, measureContext, 'NILGIRI EDU VENTURES', PADDING, y, INK_WIDTH, '11px Arial, Helvetica, sans-serif', 14, 'center');
    y += 4;
    y = addWrappedText(commands, measureContext, 'INVOICE', PADDING, y, INK_WIDTH, 'bold 13px Arial, Helvetica, sans-serif', 16, 'center');
    y += 4;
    commands.push({ type: 'rule', y });
    y += 5;

    y = addWrappedText(commands, measureContext, `Inv. No.: ${booking.id || '—'}`, PADDING, y, INK_WIDTH, boldFont, lineHeight);
    const bookingDate = booking.bookingTime ? new Date(booking.bookingTime) : null;
    y = addWrappedText(
      commands,
      measureContext,
      `Date: ${bookingDate && !Number.isNaN(bookingDate.getTime())
        ? bookingDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—'}`,
      PADDING,
      y,
      INK_WIDTH,
      regularFont,
      lineHeight
    );
    y = addWrappedText(
      commands,
      measureContext,
      `Time: ${bookingDate && !Number.isNaN(bookingDate.getTime())
        ? bookingDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        : '—'}`,
      PADDING,
      y,
      INK_WIDTH,
      regularFont,
      lineHeight
    );
    y = addWrappedText(commands, measureContext, `Customer: ${booking.customerName || 'Guest'}`, PADDING, y, INK_WIDTH, boldFont, lineHeight);
    y += 3;
    commands.push({ type: 'rule', y });
    y += 5;

    commands.push({ type: 'text', text: 'No', x: numberX, y, font: boldFont, align: 'left' });
    commands.push({ type: 'text', text: 'ITEM', x: itemX, y, font: boldFont, align: 'left' });
    commands.push({ type: 'text', text: 'QTY', x: qtyX, y, font: boldFont, align: 'center' });
    commands.push({ type: 'text', text: 'RATE', x: rateX, y, font: boldFont, align: 'right' });
    commands.push({ type: 'text', text: 'TOTAL', x: totalX, y, font: boldFont, align: 'right' });
    y += lineHeight + 2;
    commands.push({ type: 'rule', y });
    y += 5;

    let totalQuantity = 0;
    booking.items.forEach((item, index) => {
      const quantity = Number(item.quantity) || 0;
      const unitPrice = Number(item.price) || 0;
      const amount = unitPrice * quantity;
      totalQuantity += quantity;
      commands.push({ type: 'text', text: String(index + 1), x: numberX, y, font: regularFont, align: 'left' });
      y = addWrappedText(commands, measureContext, item.name || 'Item', itemX, y, itemWidth, regularFont, lineHeight);
      const rowY = y - lineHeight;
      commands.push({ type: 'text', text: String(quantity), x: qtyX, y: rowY, font: regularFont, align: 'center' });
      commands.push({ type: 'text', text: formatAmount(unitPrice), x: rateX, y: rowY, font: regularFont, align: 'right' });
      commands.push({ type: 'text', text: formatAmount(amount), x: totalX, y: rowY, font: regularFont, align: 'right' });
    });

    y += 3;
    commands.push({ type: 'rule', y });
    y += 5;
    commands.push({ type: 'text', text: 'Total', x: PADDING, y, font: 'bold 12px Arial, Helvetica, sans-serif', align: 'left' });
    commands.push({ type: 'text', text: String(totalQuantity), x: qtyX, y, font: 'bold 11px Arial, Helvetica, sans-serif', align: 'center' });
    commands.push({ type: 'text', text: formatAmount(booking.totalAmount), x: totalX, y, font: 'bold 12px Arial, Helvetica, sans-serif', align: 'right' });
    y += 16;
    commands.push({ type: 'rule', y });
    y += 5;
    y = addWrappedText(commands, measureContext, 'SUMMARY', PADDING, y, INK_WIDTH, 'bold 12px Arial, Helvetica, sans-serif', 15, 'center');
    y += 2;
    y = addWrappedText(commands, measureContext, 'CGST Amt: ₹0.00', PADDING, y, INK_WIDTH, boldFont, lineHeight);
    y = addWrappedText(commands, measureContext, 'SGST Amt: ₹0.00', PADDING, y, INK_WIDTH, boldFont, lineHeight);
    y += 3;
    commands.push({ type: 'rule', y });
    y += 5;
    y = addWrappedText(
      commands,
      measureContext,
      `Round Off: ₹${formatAmount(0)}`,
      totalX,
      y,
      INK_WIDTH,
      regularFont,
      lineHeight,
      'right'
    );
    y = addWrappedText(
      commands,
      measureContext,
      `Bill Amount: ₹${formatAmount(booking.totalAmount)}`,
      PADDING,
      y,
      INK_WIDTH,
      'bold 16px Arial, Helvetica, sans-serif',
      20,
      'center'
    );
    y = addWrappedText(commands, measureContext, amountInWords(booking.totalAmount), PADDING, y, INK_WIDTH, boldFont, lineHeight, 'center');
    y += 3;
    commands.push({ type: 'rule', y });
    y += 5;
    y = addWrappedText(commands, measureContext, 'Thank you, Visit again!', PADDING, y, INK_WIDTH, 'bold 12px Arial, Helvetica, sans-serif', 15, 'center');

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = Math.ceil(y + PADDING) * SCALE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot render receipt images.');
    context.scale(SCALE, SCALE);
    context.fillStyle = '#000';
    context.strokeStyle = '#000';
    context.lineWidth = 0.7;
    context.textBaseline = 'top';

    commands.forEach(command => {
      if (command.type === 'rule') {
        context.setLineDash([2, 2]);
        context.beginPath();
        context.moveTo(PADDING, command.y);
        context.lineTo(WIDTH - PADDING, command.y);
        context.stroke();
        context.setLineDash([]);
        return;
      }
      context.font = command.font;
      context.textAlign = command.align;
      context.fillText(command.text, command.x, command.y);
    });

    return canvas.toDataURL('image/png');
  }

  function printReceiptPng(booking, onAfterPrint, onError) {
    let frame;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frame) frame.remove();
      if (onAfterPrint) onAfterPrint();
    };
    const fail = error => {
      if (frame) frame.remove();
      if (onError) onError(error);
      else console.error('Receipt PNG printing failed:', error);
    };

    try {
      const png = createReceiptPng(booking);
      frame = document.createElement('iframe');
      frame.title = 'Receipt print frame';
      frame.style.cssText = 'position:fixed;left:0;top:0;width:58mm;height:100vh;border:0;z-index:-1;';
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style id="receipt-print-style">@page{size:58mm auto;margin:0}html,body{width:58mm;margin:0;padding:0;background:transparent}img{display:block;width:58mm;height:auto;margin:0;padding:0}</style></head><body></body></html>';

      frame.addEventListener('load', () => {
        const printWindow = frame.contentWindow;
        const image = frame.contentDocument.createElement('img');
        image.alt = 'Text-only cafe receipt';
        image.onload = () => {
          const pageHeightMm = Math.ceil((image.naturalHeight / image.naturalWidth) * PAPER_WIDTH_MM + 1);
          const style = frame.contentDocument.getElementById('receipt-print-style');
          style.textContent = `@page{size:${PAPER_WIDTH_MM}mm ${pageHeightMm}mm;margin:0}html,body{width:${PAPER_WIDTH_MM}mm;height:${pageHeightMm}mm;margin:0;padding:0;overflow:hidden;background:transparent}img{display:block;width:${PAPER_WIDTH_MM}mm;height:auto;margin:0;padding:0}`;
          frame.style.height = `${pageHeightMm}mm`;
          printWindow.addEventListener('afterprint', finish, { once: true });
          window.addEventListener('afterprint', finish, { once: true });
          try {
            printWindow.focus();
            printWindow.print();
          } catch (error) {
            fail(error);
          }
        };
        image.onerror = () => fail(new Error('Could not load the generated receipt image.'));
        image.src = png;
        frame.contentDocument.body.appendChild(image);
      }, { once: true });

      document.body.appendChild(frame);
    } catch (error) {
      fail(error);
    }
  }

  window.printReceiptPng = printReceiptPng;
})();
